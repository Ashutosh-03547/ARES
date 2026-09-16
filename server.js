require('dotenv').config();
const express = require('express');
const { GoogleGenAI } = require('@google/genai');

const app = express();
const port = 3000;

// Initialize Gemini using the key from your .env file
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

app.use(express.json());

// The endpoint that listens for your commands
app.post('/api/command', async (req, res) => {
    const userCommand = req.body.command;
    console.log(`\n[User]: ${userCommand}`);

    try {
        // We are adding system_instruction to define the persona
        const interaction = await ai.interactions.create({
            model: 'gemini-3.6-flash',
            input: userCommand,
            system_instruction: "You are A.R.E.S. (Authorized Reasoning & Execution System), a highly secure, concise, and professional desktop AI assistant. Never act like a generic chatbot. Your purpose is to manage local system tasks. Keep answers under 3 sentences unless asked for details.",
        });

        const aiText = interaction.text || JSON.stringify(interaction);
        console.log(`[A.R.E.S.]: ${aiText}`);

        res.status(200).send({ reply: aiText });
    } catch (error) {
        console.error("Error communicating with Gemini:", error);
        res.status(500).send({ error: "Brain disconnected." });
    }
});

app.listen(port, () => {
    console.log('--------------------------------------------');
    console.log(`A.R.E.S. PRIMARY HUB ONLINE at http://localhost:${port}`);
    console.log('Gemini 3.6 Flash Module: CONNECTED');
    console.log('--------------------------------------------');
});