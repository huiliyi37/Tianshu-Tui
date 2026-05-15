## Read File Tool

Read files from the filesystem with optional line range.

### Usage
- Always provide absolute file paths
- Use offset and limit to read specific ranges instead of reading entire large files
- Results are truncated at 8000 characters — use offset/limit for large files
- This tool can read text files, images (PNG/JPG), and PDF files
- Do NOT re-read files already read in this session unless they were modified

### Examples
Good: `read_file(file_path="/abs/path/src/app.ts")`
Good: `read_file(file_path="/abs/path/src/app.ts", offset=100, limit=50)`
Bad: `read_file(file_path="src/app.ts")` (relative path)
Bad: re-reading the same file multiple times in one session without it being modified
