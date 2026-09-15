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
        // Send the user's command to the new Gemini 3.6 Flash model
        // using the recommended Interactions API
        const interaction = await ai.interactions.create({
            model: 'gemini-3.6-flash',
            input: userCommand,
        });

        // The Interactions API returns the response differently
        // Usually, the text is available directly on the interaction object
        // If interaction.text is undefined, we can stringify the object to see its structure
        const aiText = interaction.text || JSON.stringify(interaction);

        console.log(`[A.R.E.S.]: ${aiText}`);

        // Send the AI's response back to the requester
        res.status(200).send({
            reply: aiText
        });

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