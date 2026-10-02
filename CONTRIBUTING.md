# Contributing

## Development setup

```bash
cd site
npm ci
npm start          # http://localhost:7777
npm test           # JS syntax + n8n workflow integrity
```

The full stack (n8n, ffmpeg, ASR service, Ollama) is described in [docs/setup.md](docs/setup.md).

## Ground rules

- **Workflows** live in `n8n/` as exports. After editing in n8n, export the workflow, remove any
  credential ids, and commit the JSON. `npm test` fails if a `$('Node name')` reference points to a
  node that no longer exists — renaming a node in n8n does not update these references.
- **Prompts:** do not weaken rule 1 of the MoM prompt (restore garbled words, never invent drugs,
  diagnoses, names or numbers). Check changes with `node tools/check-mom-grounded.js --all ru`.
- **Transcript assembly** stays in code ("Final transcript" node): no model may rewrite the transcript text.
- **Never commit** recordings, transcripts, reports, `site/data/`, `.n8n-key`, `.mail-*` or real names of patients or staff.
- Code style: see `.editorconfig`. Code, comments and UI text are in English.
