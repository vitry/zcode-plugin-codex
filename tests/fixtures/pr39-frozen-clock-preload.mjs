import { PR39_FROZEN_NOW } from './pr39-origin-route-compatibility.mjs';

if (process.env.PR39_FROZEN_CLOCK === '1') Date.now = () => Date.parse(PR39_FROZEN_NOW);
