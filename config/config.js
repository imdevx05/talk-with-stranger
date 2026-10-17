window.TALKATCH_CONFIG = {
  supabaseUrl: "https://bpfbutcrckutvkaezhfr.supabase.co",
  supabaseAnonKey: "PASTE_YOUR_SUPABASE_PUBLISHABLE_OR_ANON_KEY",

  maxFileBytes: 15 * 1024 * 1024,

  // STUN works on many networks; some networks require TURN.
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" }
  ]
};
