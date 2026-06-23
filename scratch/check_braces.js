import fs from 'fs';
const content = fs.readFileSync('public/styles.css', 'utf8');

let openBraces = 0;
let lineNum = 1;
let lastOpenLine = 0;

for (let i = 0; i < content.length; i++) {
  const char = content[i];
  if (char === '\n') {
    lineNum++;
  }
  if (char === '{') {
    openBraces++;
    lastOpenLine = lineNum;
  } else if (char === '}') {
    openBraces--;
    if (openBraces < 0) {
      console.log(`Error: Extra closing brace at line ${lineNum}`);
      process.exit(1);
    }
  }
}

if (openBraces > 0) {
  console.log(`Error: Unclosed brace! Total open: ${openBraces}, last opened around line ${lastOpenLine}`);
  process.exit(1);
} else {
  console.log("Braces are balanced!");
}
