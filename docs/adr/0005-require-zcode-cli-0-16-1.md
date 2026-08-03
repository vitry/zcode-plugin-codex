# Require ZCode CLI 0.16.1 or newer

The plugin requires ZCode CLI 0.16.1 or newer and uses its session-level model protocol, including the optional `model` on `session/create` and `session/setModel` for resumed work. Supporting 0.15.x would force misleading no-op model selection and maintain two materially different protocol paths, undermining the requested command parity.
