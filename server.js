require('dotenv').config();
const say = require('say');
const express = require('express');
const { GoogleGenAI } = require('@google/genai');
const memory = require('./memory');
const { parseMemoryCommand } = require('./memory/commandParser');

const app = express();
const port = 3000;

// Initialize Gemini using the key from your .env file
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

app.use(express.json());

memory.init();

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

    // 1b. Deterministic memory commands, classified here (not by the LLM)
    // so the model itself can never trigger a memory write. See
    // memory/commandParser.js for the exact-match-only "forget" rules
    // that keep casual phrases like "forget it" from deleting anything.
    const memoryCommand = parseMemoryCommand(userCommand);
    if (memoryCommand.type === 'remember') {
        memory.remember(memoryCommand.fact, memoryCommand.fact, 'general', 'USER_ADMIN');
    } else if (memoryCommand.type === 'forget_exact') {
        const result = memory.forget(memoryCommand.key);
        const reply = result.deleted
            ? "Understood. I've forgotten that."
            : "I don't have anything stored that matches that.";
        console.log(`[A.R.E.S.]: ${reply}`);
        memory.addTurn('user', userCommand, 'USER_ADMIN');
        memory.addTurn('assistant', reply, 'EXTERNAL_SOURCE');
        say.speak(cleanForSpeech(reply), 'Microsoft Zira Desktop', 1.0);
        return res.status(200).send({ reply });
    } else if (memoryCommand.type === 'forget_maybe') {
        // Only acts on an exact stored key; a miss here is deliberately
        // silent (not a "nothing matched" reply) since the phrase may not
        // have been a memory command at all.
        memory.forget(memoryCommand.key);
    }

    // 2. Generate dynamic time context
    const now = new Date();
    const timeContext = `[SYSTEM CONTEXT: Current local time is ${now.toLocaleString()}. Host machine: Asus i5-12500H.] `;

    // 3. Merge memory (core + working history) with the time context and user command
    const persona = "Keep answers professional, crisp, and confident. If asked to introduce yourself, give a brief, impressive 2-sentence overview of your architecture, security sandbox, and purpose. Do not use markdown formatting.";
    const { systemInstruction, historyText } = memory.getContext(userCommand, { personaInstruction: persona });
    const finalInput = `${historyText ? historyText + '\n\n' : ''}${timeContext}User says: ${userCommand}`;

    try {
        const interaction = await ai.interactions.create({
            model: 'gemini-3.6-flash',
            input: finalInput,
            system_instruction: systemInstruction,
        });

        const aiText = interaction.output_text || interaction.text || JSON.stringify(interaction);
        console.log(`[A.R.E.S.]: ${aiText}`);

        memory.addTurn('user', userCommand, 'USER_ADMIN');
        memory.addTurn('assistant', aiText, 'EXTERNAL_SOURCE');

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