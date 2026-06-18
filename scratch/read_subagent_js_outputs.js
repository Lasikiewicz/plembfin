import fs from "node:fs";
import readline from "node:readline";

async function parseJsOutputs() {
  const filePath = "C:\\Users\\lasik\\.gemini\\antigravity-ide\\brain\\b9bb232b-26d5-41d1-8b95-d39193edcdac\\.system_generated\\logs\\transcript.jsonl";
  if (!fs.existsSync(filePath)) {
    return;
  }
  
  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  for await (const line of rl) {
    try {
      const parsed = JSON.parse(line);
      const content = parsed.content || "";
      const output = parsed.output || "";
      
      // Look for steps containing "Fetch broken statuses" or similar
      if (content.includes("Fetch broken statuses") || content.includes("Fetch status of broken images")) {
        console.log(`\n--- JS Execute Step ${parsed.step_index} ---`);
        console.log("Content:", content.substring(0, 300));
        console.log("Output:", output.substring(0, 1000));
      }
      
      // Look for the output containing the JSON list of images
      if (content.includes("Get images JSON") || content.includes("check_homepage_posters")) {
        if (output && output.includes("Widow's Bay")) {
          console.log(`\n--- Images JSON Step ${parsed.step_index} ---`);
          console.log("Output:", output.substring(0, 1500));
        }
      }
    } catch (e) {}
  }
}

parseJsOutputs();
