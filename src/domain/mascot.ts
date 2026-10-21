export const MASCOT_MOODS = ['normal', 'happy', 'sad', 'thinking', 'sleepy'] as const;
export type MascotMood = (typeof MASCOT_MOODS)[number];

export const NON_SLEEPY_MASCOT_MOODS = ['normal', 'happy', 'sad', 'thinking'] as const;
export type NonSleepyMascotMood = (typeof NON_SLEEPY_MASCOT_MOODS)[number];

