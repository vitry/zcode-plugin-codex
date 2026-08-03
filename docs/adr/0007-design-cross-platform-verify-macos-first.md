# Design cross-platform and verify real ZCode on macOS first

The runtime supports macOS, Linux, and Windows paths, broker transports, process cancellation, and executable discovery, with fake app-server tests on all three platforms. The first release performs real ZCode 0.16.1 end-to-end qualification on macOS; Linux and Windows remain code-supported but explicitly unqualified against a real CLI until those environments are available.
