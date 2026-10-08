# TODO

- [ ] Evaluate recent-inbound-traffic HTTP/2 ping suppression separately from
  parallel tool-call batching. Compare Cursor CLI connection management with
  [the fork's transport optimization](https://github.com/nkoynov/cursor-opencode-provider/commit/c1643f7009a575350dc95f1a1ba299938efdda9e)
  and [cancellation follow-up](https://github.com/nkoynov/cursor-opencode-provider/commit/e498c9e45b002ca469a0ca793b20555ca6bfea60).
  Measure the benefit and test retired-session cancellation on Bun and Node;
  any resend must preserve replay safety and must not treat missing response
  headers as proof that a stateful Run was never processed.

- [ ] Design how Cursor metadata spills (`write_args` to
  `<project_folder>/agent-tools/<uuid>.txt`) are written, to match Cursor CLI
  behavior instead of routing them through the host `write` tool.
