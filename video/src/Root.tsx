import { Composition, staticFile } from "remotion";
import { Demo, type Take } from "./Demo";

/** The take (scripts/demo-video-v2.mjs) sets the length: the edit runs exactly as long as the recording. */
export const Root = () => (
  <Composition
    id="FollowUpDemo"
    component={Demo}
    width={1920}
    height={1200}
    fps={30}
    durationInFrames={30}
    defaultProps={{ take: null as Take | null }}
    calculateMetadata={async ({ props }) => {
      const take: Take = props.take ?? (await (await fetch(staticFile("take/take.json"))).json());
      return { durationInFrames: Math.round(take.seconds * take.fps), fps: take.fps, props: { take } };
    }}
  />
);
