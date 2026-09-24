import type { FaceLandmarker, FaceLandmarkerResult } from "@mediapipe/tasks-vision";

// On-device face landmarks (MediaPipe, WASM + GPU where available). The model
// and wasm are served locally from /mediapipe (staged by scripts/fetch-models.mjs),
// so the user's face never leaves the browser for detection.

type Mode = "IMAGE" | "VIDEO";
const cache = new Map<Mode, Promise<FaceLandmarker>>();

export function getLandmarker(mode: Mode): Promise<FaceLandmarker> {
  let p = cache.get(mode);
  if (!p) {
    p = create(mode);
    cache.set(mode, p);
    p.catch(() => cache.delete(mode));
  }
  return p;
}

async function create(mode: Mode): Promise<FaceLandmarker> {
  const { FaceLandmarker, FilesetResolver } = await import("@mediapipe/tasks-vision");
  const fileset = await FilesetResolver.forVisionTasks("/mediapipe/wasm");
  const base = {
    runningMode: mode,
    numFaces: 3, // >1 so we can tell the user "only one face, please"
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: mode === "VIDEO",
    minFaceDetectionConfidence: 0.5,
    minFacePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  } as const;
  try {
    return await FaceLandmarker.createFromOptions(fileset, {
      ...base,
      baseOptions: { modelAssetPath: "/mediapipe/face_landmarker.task", delegate: "GPU" },
    });
  } catch {
    // Some browsers/GPUs refuse the GPU delegate; CPU is slower but fine.
    return FaceLandmarker.createFromOptions(fileset, {
      ...base,
      baseOptions: { modelAssetPath: "/mediapipe/face_landmarker.task", delegate: "CPU" },
    });
  }
}

export function blendshape(result: FaceLandmarkerResult, name: string, face = 0): number {
  return result.faceBlendshapes?.[face]?.categories.find((c) => c.categoryName === name)?.score ?? 0;
}
