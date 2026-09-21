// Intro director + renderer. State is a pure function of time: renderAt(t),
// driven by a single master clock. Not implemented yet — M3.
//
// Milestone order (see HEADWATERS_INTRO_PLAN.md): M2 static final-frame
// render, M3 renderAt(t) + camera + markers, M4 captions + skip + reduced
// motion, M5 CTA + shared-element transition into the dashboard.
//
// M3 label placement: don't pin river-name labels at the static headwater
// dot (M1's final-frame.svg review copy does this and several overlap —
// Colorado/Yampa/Gunnison/Arkansas/Platte headwaters all cluster in central
// CO). Instead, track each label to the leading edge of its river as it
// draws, per review feedback on the M1 static render.
