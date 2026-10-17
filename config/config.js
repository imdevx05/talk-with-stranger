window.TALKATCH_CONFIG = {
  supabaseUrl: "https://vwkqpaedwcyuzbrxfjay.supabase.co",
  supabaseAnonKey: "sb_publishable_omRb85F89tssTvT_EsfZMw_Ahodymyg",

  maxFileBytes: 15 * 1024 * 1024,

  // STUN works on many networks; some networks require TURN.
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" }
  ]
};
