// api/index.js
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const Redis = require('ioredis');

const app = express();
app.use(express.json());

// 1. Inicializa o cliente Redis a partir da variável de ambiente
// A biblioteca 'ioredis' entende a string de conexão da Vercel/Upstash nativamente.
// A opção 'lazyConnect: true' é uma boa prática em ambientes serverless.
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

    const licenseKey = `DEVLOG-${uuidv4().toUpperCase()}`;
    const licenseData = {
        email: email,
        createdAt: new Date().toISOString(),
        status: 'active',
    };

    try {
        // 2. Armazena a chave no Redis
        // 'set' no ioredis: chave, valor (stringificado), e 'EX' para expiração (opcional)
        await redis.set(licenseKey, JSON.stringify(licenseData));
        // Criamos um índice reverso para encontrar a chave pelo email, se necessário
        await redis.set(`email:${email}`, licenseKey);

        console.log(`Generated license ${licenseKey} for ${email}`);
        
        return res.status(200).json({ licenseKey: licenseKey });

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
        // 3. Busca a chave no Redis
        const result = await redis.get(licenseKey);

        if (!result) {
            return res.status(404).json({ valid: false, reason: 'License not found' });
        }

        // 'result' é uma string, precisamos fazer o parse
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

// Exporta o app para a Vercel (sem mudanças aqui)
module.exports = app;