require('dotenv').config();
const express = require('express');
const { GoogleGenAI } = require('@google/genai');
const say = require('say');

const app = express();
const port = 3000;

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
app.use(express.json());

// 4. MEMORY: Global variable to store the session ID
let lastInteractionId = null;

// 2. SANITIZATION: Clean up text so it sounds human
function cleanForSpeech(text) {
    return text.replace(/[*#_`]/g, '').replace(/:/g, ',');
}

app.post('/api/command', async (req, res) => {
    // 3. INTERRUPTION: Instantly stop any previous speech
    say.stop();

    const userCommand = req.body.command;
    console.log(`\n[User]: ${userCommand}`);

    const now = new Date();
    const timeContext = `[SYSTEM CONTEXT: Current local time is ${now.toLocaleString()}. Host machine: Lenovo i5-12500H.] `;
    const finalInput = `${timeContext}User says: ${userCommand}`;

    try {
        const requestParams = {
            model: 'gemini-3.6-flash',
            input: finalInput,
            system_instruction: "You are A.R.E.S., a highly secure desktop AI assistant. Keep answers professional, crisp, and confident. Do not use markdown or complex formatting.",
        };

        // 4. MEMORY: Pass the previous interaction ID to remember the conversation
        if (lastInteractionId) {
            requestParams.previous_interaction_id = lastInteractionId;
        }

        const interaction = await ai.interactions.create(requestParams);

        if (interaction.id) {
            lastInteractionId = interaction.id;
        }

        const aiText = interaction.output_text || interaction.text || JSON.stringify(interaction);
        console.log(`[A.R.E.S.]: ${aiText}`);

        const spokenText = cleanForSpeech(aiText);

        // 1. FEMALE VOICE: Use the default Windows female voice
        say.speak(spokenText, 'Microsoft Zira Desktop', 1.0);

        res.status(200).send({ reply: aiText });
    } catch (error) {
        console.error("Error communicating with Gemini:", error);
        res.status(500).send({ error: "Brain disconnected." });
    }
});

app.listen(port, () => {
    console.log(`A.R.E.S. server listening on http://localhost:${port}`);
});