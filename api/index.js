const express = require('express');
const { v4: uuidv4 } = require('uuid');
const Redis = require('ioredis');
const { status } = require('express/lib/response');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
app.use(express.json());
app.use('/api/stripe-webhook', express.raw({ type: 'application/json' }));
app.use(express.json);

const redis = new Redis(process.env.REDIS_URL, { lazyConnect: true });

// --- ENDPOINT 1: Gerar Licença (Protegido por Segredo) ---
app.post('/api/generate-license', async (req, res) => {
    const { secret, email } = req.body;
    if (secret !== process.env.GENERATION_SECRET_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!email) {
        return res.status(400).json({ error: 'Email is required' });
    }

    try {
        const { licenseKey } = await createAndStoreLicense(email, redis);
        return res.status(200).json({ licenseKey });
    } catch (error) {
        console.error("Error generating license:", error);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

// --- ENDPOINT 2: Verificar Licença (Público, chamado pela extensão) ---
app.post('/api/verify-license', async (req, res) => {
    const { licenseKey } = req.body;
    if (!licenseKey) {
        return res.status(400).json({ error: 'License key is required' });
    }

    try {
        const result = await redis.get(licenseKey);

        if (!result) {
            return res.status(404).json({ valid: false, reason: 'License not found' });
        }

        const licenseData = JSON.parse(result);

        if (licenseData.status === 'active') {
            return res.status(200).json({ valid: true, email: licenseData.email });
        } else {
            return res.status(403).json({ valid: false, reason: `License is ${licenseData.status}` });
        }

    } catch (error) {
        console.error("Error verifying license:", error);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

async function createAndStoreLicense(email, redis) {
    const existingLicenseKey = await redis.get(`email:${email}`);
    if(existingLicenseKey) {
        console.log(`License alreade exists for ${email}. Returning existing key: ${existingLicenseKey}`);
        return { licenseKey: existingLicenseKey, isNew: false };
    }

    const licenseKey = `DEVLOG-${uuidv4().toUpperCase()}`;
    const licenseData = {
        email: email,
        createdAt: new Date().toISOString(),
        status: 'active',
        source: 'stripe'
    };

    await redis.multi()
        .set(licenseKey, JSON.stringify(licenseData))
        .set(`email:${email}`, licenseKey)
        .exec();

    console.log(`Generated new license ${licenseKey} for ${email} via Stripe`);
    return {licenseKey, isNew: true};
}

// ENDPOINT: Stripe Webhook (public)
app.post('/api/stripe-webhook', async (req, res) => {
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
    const sig = req.headers['stripe-signature'];

    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } catch (err) {
        console.error(`Webhook signature verification failed`, err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if(event.type === 'checkout.session.completed') {
        const session = event.data.object;

        if (session.payment.status === 'paid') {
            const customerEmail = session.customer_details.email;

            if (!customerEmail){
                console.error("Checkout session completed without customer email");
                return res.status(400).json({ error: 'Customer email not found' });
            }

            try {
                const { licenseKey } = await createAndStoreLicense(customerEmail, redis);

                console.log(`Sucessfully processed license for ${customerEmail}. KEY: ${licenseKey}`);
            } catch (error) {
                console.error("Error processing license after payment:", error);
                return res.status(500).json({ error: 'Internal server error during license generation' })
            }
        }
    }
    res.status(200).json({ received: true });
})

module.exports = app;