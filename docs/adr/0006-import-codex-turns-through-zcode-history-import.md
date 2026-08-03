# Import Codex turns through ZCode's history importer

`$zcode:transfer` reads the current Codex thread through stable Codex app-server APIs, converts its user and assistant turns, and supplies them to ZCode 0.16.1 `session/create.importedHistory` so the new session has real ordered history rather than one seed prompt. ZCode 0.16.1 restricts the import source discriminator to `claudeCode`; the adapter temporarily uses that value while presenting the session as imported from Codex and isolates the compatibility quirk so a future `codex` discriminator can replace it locally.
