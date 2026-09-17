require('dotenv').config();
const say = require('say');
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

    // 1. GENERATE DYNAMIC TIME CONTEXT
    const now = new Date();
    const timeContext = `[SYSTEM CONTEXT: Current local time is ${now.toLocaleString()}. Host machine: Asus i5-12500H.] `;

    // 2. MERGE CONTEXT WITH USER COMMAND
    const finalInput = `${timeContext}User says: ${userCommand}`;

    try {
        const interaction = await ai.interactions.create({
            model: 'gemini-3.6-flash',
            input: finalInput,
            system_instruction: "You are A.R.E.S. (Authorized Reasoning & Execution System), a highly secure desktop AI assistant developed by Ashutosh. Keep answers professional, crisp, and confident. If asked to introduce yourself, give a brief, impressive 2-sentence overview of your architecture, security sandbox, and purpose.",
        });

        const aiText = interaction.text || JSON.stringify(interaction);
        console.log(`[A.R.E.S.]: ${aiText}`);
        say.speak(aiText);
        res.status(200).send({ reply: aiText });
    } catch (error) {
        console.error("Error communicating with Gemini:", error);
        res.status(500).send({ error: "Brain disconnected." });
    }
});

app.listen(port, () => {
    console.log(`A.R.E.S. server listening on http://localhost:${port}`);
});