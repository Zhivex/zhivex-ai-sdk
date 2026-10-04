# External runtime presentation, offline

From the repository root, run `bun run build`, then
`bun examples/react-external-runtime/server.ts`. Open http://127.0.0.1:3111.
Send a message and approve or reject the fixture review. No provider, network
service, credential, or agent execution is used.

The host owns one immutable snapshot, its transcript, activity and review tokens.
`useExternalChat` subscribes to it and derives the existing `ChatState` presentation
contract without copying it into another state store. `ZhivexChat` reuses
`ChatRoot`, `MessageList`, `Message` and `Composer`. `ReviewCard` closes over the
opaque host token; neither the hook nor the card interprets it as an SDK approval.

Replace the offline host with an adapter to your existing durable runtime. Keep
`getSnapshot` referentially stable until a change, return immutable snapshots, and
provide `getServerSnapshot` when rendering on the server. Host callbacks remain
responsible for session ownership, durable acknowledgements and stale reviews.
Use `ChatTransport` and `useZhivexChat` when the SDK should own stream reduction;
do not run both ownership models for the same conversation.
