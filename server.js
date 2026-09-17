require('dotenv').config();
const say = require('say');
const express = require('express');
const { GoogleGenAI } = require('@google/genai');

const app = express();
const port = 3000;

// Initialize Gemini using the key from your .env file
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

app.use(express.json());

// Persistent memory tracking variable
let lastInteractionId = null;

// Clean text so the speech engine doesn't read out symbols or colons
function cleanForSpeech(text) {
    if (!text || typeof text !== 'string') return "I encountered an error.";
    return text.replace(/[*#_`\[\]\{\}]/g, '').replace(/:/g, ',');
}

// The endpoint that listens for your commands
app.post('/api/command', async (req, res) => {
    // 1. Instantly stop any ongoing speech when a new prompt is injected
    say.stop();

    const userCommand = req.body.command;
    console.log(`\n[User]: ${userCommand}`);

    // 2. Generate dynamic time context
    const now = new Date();
    const timeContext = `[SYSTEM CONTEXT: Current local time is ${now.toLocaleString()}. Host machine: Asus i5-12500H.] `;

    // 3. Merge context with user command
    const finalInput = `${timeContext}User says: ${userCommand}`;

    try {
        const requestParams = {
            model: 'gemini-3.6-flash',
            input: finalInput,
            system_instruction: "You are A.R.E.S. (Authorized Reasoning & Execution System), a highly secure desktop AI assistant developed by Ashutosh. Keep answers professional, crisp, and confident. If asked to introduce yourself, give a brief, impressive 2-sentence overview of your architecture, security sandbox, and purpose. Do not use markdown formatting.",
        };

        // 4. Memory management: pass the previous interaction ID to maintain conversation history
        if (lastInteractionId) {
            requestParams.previous_interaction_id = lastInteractionId;
        }

        const interaction = await ai.interactions.create(requestParams);

        if (interaction.id) {
            lastInteractionId = interaction.id;
        }

        const aiText = interaction.output_text || interaction.text || JSON.stringify(interaction);
        console.log(`[A.R.E.S.]: ${aiText}`);

        // 5. Sanitize text and route it to the Windows Zira female voice
        const spokenText = cleanForSpeech(aiText);
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