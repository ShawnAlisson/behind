# Takeaway

Pick a **sample video**, digest **that clip**, and get one **novel, practical finding** — not a search-and-list of videos.

## Demo flow

1. Choose a sample from the rail (lab corpus only).
2. Watch the clip.
3. Pick a lens (Safety / Ops / Training) and hit **Digest this clip**.
4. Read: novel finding → why it matters → practical next step.
5. Optionally ask follow-ups scoped to that same video.

## Constraints

- **Lab corpus only.** Do not ingest YouTube / arbitrary internet video (licensing).
- Deploy via ConfigMap → Ingress `/app` (see `deploy-app-no-registry`).
- On-cluster `VSS_URL=http://video-backend-service:8000`.
- UI assets must stay **flat** next to `main.py` (no nested folders in ConfigMap).

## Why this idea

Search hit lists feel like a generic VSS demo. Takeaway forces depth on one clip: synthesize the whole parent video, then turn that into something an operator can act on tomorrow.

## Open

[workshop.thecosmoslabs.com](https://workshop.thecosmoslabs.com) → **App**
