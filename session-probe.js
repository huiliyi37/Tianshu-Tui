const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const sessionsDir = 'C:/Users/heye/AppData/Local/.rivet/sessions';
const slug = 'Tianshu-Tui-' + crypto.createHash('sha256').update('D:\\Tianshu-Tui').digest('hex').slice(0, 6);

const result = {
  sessionsExists: fs.existsSync(sessionsDir),
  slug,
  slugDir: path.join(sessionsDir, slug),
  slugExists: false,
  entries: [],
};

if (fs.existsSync(sessionsDir)) {
  const entries = fs.readdirSync(sessionsDir);
  result.entries = entries;
  const slugDir = path.join(sessionsDir, slug);
  result.slugExists = fs.existsSync(slugDir);
  if (result.slugExists) {
    const files = fs.readdirSync(slugDir);
    const sessionFiles = files.filter(f => f.endsWith('.jsonl'));
    result.sessionFiles = sessionFiles;
    // Get first session file's first 500 chars
    if (sessionFiles.length > 0) {
      const firstFile = path.join(slugDir, sessionFiles[0]);
      const content = fs.readFileSync(firstFile, 'utf8').slice(0, 500);
      result.firstFileSample = content;
    }
  }
}

fs.writeFileSync('D:/Tianshu-Tui/session-probe.json', JSON.stringify(result, null, 2));
