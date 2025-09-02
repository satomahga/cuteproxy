const axios = require("axios");

function randomInteger(max) {
  return Math.floor(Math.random() * max + 1);
}

async function testQueue() {
  const requests = Array(10).fill(undefined).map(async function() {
    const maxTokens = randomInteger(2000);

    const headers = {
      "Authorization": "Bearer test",
      "Content-Type": "application/json",
      "X-Forwarded-For": `${randomInteger(255)}.${randomInteger(255)}.${randomInteger(255)}.${randomInteger(255)}`,
    };

    const payload = {
      model: "gpt-4o-mini-2024-07-18",
      max_tokens: 20 + maxTokens,
      stream: false,
      messages: [{role: "user", content: "You are being benchmarked regarding your reliability at outputting exact, machine-comprehensible data. Output the sentence \"The quick brown fox jumps over the lazy dog.\" Do not precede it with quotemarks or any form of preamble, and do not output anything after the sentence."}],
      temperature: 0,
    };

    try {
      const response = await axios.post(
        "http://localhost:7860/proxy/openai/v1/chat/completions",
        payload,
        { headers }
      );

            if (response.status !== 200) {
          console.error(`Request {$maxTokens} finished with status code ${response.status} and response`, response.data);
          return;
        }

      const content = response.data.choices[0].message.content;

      console.log(
        `Request ${maxTokens} `,
        content === "The quick brown fox jumps over the lazy dog." ? "OK" : `mangled: ${content}`
      );
    } catch (error) {
      const msg = error.response;
      console.error(`Error in req ${maxTokens}:`, error.message, msg || "");
    }
  });

  await Promise.all(requests);
  console.log("All requests finished");
}

testQueue();
