/** Selection rules shared by the video-model dropdowns (board modal, graph
 *  video/in-betweener nodes, tween timeline): when a model's live options
 *  arrive, a stale resolution re-picks the CLOSEST supported one instead of
 *  falling back to the first. The pure ranking lives in `shared/resolution.ts`
 *  so main's provider submit paths clamp onto the same tiers. */
export { closestResolution, resolutionWeight } from "../../../shared/resolution.js";
