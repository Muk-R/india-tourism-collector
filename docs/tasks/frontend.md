# Agent task: frontend
Branch: dev/frontend

## Owned paths
- frontend/** only
- Do not edit Worker, contracts, tests, or shared docs. Request contract amendments from integration.

## Work
Create a functional mobile-first Localise web pilot from scratch. Use a modern, accessible visual system with soft matte-glass cards, subtle depth/shadows, restrained highlights, strong readability, and bottom navigation including Home, Itineraries, Social, and useful destinations. Build city landing pages with historical significance, famous landmark highlights, food, and accommodation sections. Prioritize famous attractions in presentation. Integrate itinerary views when the planned contract is available. Existing Worker API routes are identified in contracts/openapi.yaml; all planned routes must be treated as unavailable. Clearly label any mock city, attraction, hotel, restaurant, history, image, or itinerary data as mock. Never imply mock data is verified. Keep unverified image candidates out of production presentation or label them appropriately; preserve attribution where sourced.

## Acceptance and tests
Responsive mobile/tablet/desktop layouts; keyboard and screen-reader navigation; accessible contrast and focus; empty/loading/error states; no fabricated hotel ratings or dietary labels; tests for key UI and navigation behavior. Use mock data until integration is available. Keep dependencies lean; install only trusted necessary packages. Do not download image collections.

## Dependencies and coordination
Consume contracts/openapi.yaml without changing it. Planned endpoint changes require integration coordination. Avoid direct database/provider calls from the browser.

## Autonomous operation / approval
Read AGENTS.md first, inspect status, implement, test, debug, review, checkpoint, and commit milestones autonomously. Stop only for disallowed access, destructive operations, credentials, paid services, or a contract blocker; continue independent UI work.
