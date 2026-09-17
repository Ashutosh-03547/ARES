require('dotenv').config();
const express = require('express');
const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process'); // Node's built-in system executor

// Import the unlimited Edge Neural TTS
const { MsEdgeTTS } = require('msedge-tts');

const app = express();
const port = 3000;

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
app.use(express.json());

let lastInteractionId = null;

// NEW: Native Windows Human Voice Function (No sound-play required)
async function speakHuman(text) {
    try {
        const tts = new MsEdgeTTS();

        // Use RIFF (WAV) format instead of MP3 so Windows can play it natively
        await tts.setMetadata('en-US-AriaNeural', 'riff-24khz-16bit-mono-pcm');

        const filePath = './ares_speech.wav';
        await tts.toFile(filePath, text);

        // Resolve the absolute path for PowerShell
        const fullPath = path.resolve(filePath);

        // Use native Windows PowerShell to play the audio synchronously
        exec(`powershell -c (New-Object System.Media.SoundPlayer '${fullPath}').PlaySync()`);

    } catch (error) {
        console.error("Voice synthesis failed:", error.message);
    }
}

function cleanForSpeech(text) {
    return text.replace(/[*#_`]/g, '').replace(/:/g, ',');
}

app.post('/api/command', async (req, res) => {
    const userCommand = req.body.command;
    console.log(`\n[User]: ${userCommand}`);

    const now = new Date();
    const timeContext = `[SYSTEM CONTEXT: Current local time is ${now.toLocaleString()}. Host machine: Lenovo i5-12500H.] `;
    const finalInput = `${timeContext}User says: ${userCommand}`;

    try {
        const requestParams = {
            model: 'gemini-3.6-flash',
            input: finalInput,
            system_instruction: "You are A.R.E.S., a highly secure desktop AI assistant. Keep answers under 2 sentences, professional, crisp, and confident. Do not use markdown.",
        };

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

        // Trigger the native voice function
        speakHuman(spokenText);

        res.status(200).send({ reply: aiText });
    } catch (error) {
        console.error("Error:", error);
        res.status(500).send({ error: "Brain disconnected." });
    }
});

app.listen(port, () => {
    console.log(`A.R.E.S. server listening on http://localhost:${port}`);
});