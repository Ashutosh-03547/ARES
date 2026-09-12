// Basic Gemini API test server
// Run with: GEMINI_API_KEY=your_key node server.js
// Test with: curl -X POST http://localhost:3000/generate \
//   -H "Content-Type: application/json" -d "{\"prompt\":\"Hello Gemini\"}"

const http = require("http");

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = "gemini-2.0-flash";

async function generateText(prompt) {
	if (!API_KEY) {
		throw new Error("GEMINI_API_KEY is not set");
	}

	const response = await fetch(
		`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				contents: [{ parts: [{ text: prompt }] }],
			}),
		}
	);

	const data = await response.json();
	if (!response.ok) {
		throw new Error(data.error?.message || "Gemini API request failed");
	}

	return data.candidates?.[0]?.content?.parts?.[0]?.text || "No response text";
}

const server = http.createServer(async (req, res) => {
	res.setHeader("Content-Type", "application/json");

	if (req.method === "GET" && req.url === "/") {
		res.end(JSON.stringify({ message: "Gemini test server is running" }));
		return;
	}

	if (req.method === "POST" && req.url === "/generate") {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", async () => {
			try {
				const { prompt } = JSON.parse(body);
				if (!prompt) throw new Error('Request must include a "prompt"');

				const text = await generateText(prompt);
				res.end(JSON.stringify({ text }));
			} catch (error) {
				res.statusCode = 400;
				res.end(JSON.stringify({ error: error.message }));
			}
		});
		return;
	}

	res.statusCode = 404;
	res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, () => {
	console.log(`Server running at http://localhost:${PORT}`);
});
