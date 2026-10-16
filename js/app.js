(() => {
  "use strict";

  const config = window.TALKATCH_CONFIG || {};
  const $ = (selector) => document.querySelector(selector);

  let supabase;
  let currentUser = null;
  let currentProfile = null;
  let activePerson = null;
  let activeChannel = null;
  let messagesChannel = null;
  let people = [];
  let toastTimer;
  let pc = null;
  let localStream = null;
  let callId = null;
  let callMode = "audio";
  let callDirection = null;
  let pendingOffer = null;
  let pendingIce = [];
  let callChannel = null;
  let callWatcher = null;
  let makingOffer = false;

  const MAX_FILE_SIZE = 15 * 1024 * 1024;
  const FILE_BUCKET = "chat-files";
  const AVATAR_BUCKET = "avatars";

  const rtcConfig = {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" }
    ]
  };

  function toast(message) {
    const el = $("#toast");
    if (!el) return;

    el.textContent = message;
    el.classList.add("show");

    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 3500);
  }

  function escapeHTML(value = "") {
    return String(value).replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[char]);
  }

  function avatarURL(profile) {
    if (profile && profile.avatar_url) return profile.avatar_url;

    const name = encodeURIComponent(
      (profile && (profile.display_name || profile.username)) || "User"
    );

    return `https://ui-avatars.com/api/?name=${name}&background=6658e8&color=fff`;
  }

  function refreshIcons() {
    try {
      if (window.lucide) window.lucide.createIcons();
    } catch (error) {
      console.warn("Icon rendering error:", error);
    }
  }

  function setAuthMessage(message) {
    const el = $("#auth-message");
    if (el) el.textContent = message;
  }

  function showAuth() {
    if ($("#auth-screen")) $("#auth-screen").hidden = false;
    if ($("#app-screen")) $("#app-screen").hidden = true;

    document.body.classList.remove("chat-open");
  }

  function showApp() {
    if ($("#auth-screen")) $("#auth-screen").hidden = true;
    if ($("#app-screen")) $("#app-screen").hidden = false;

    refreshIcons();
  }

  function setAuthTab(tab) {
    const login = tab === "login";

    if ($("#loginForm")) $("#loginForm").hidden = !login;
    if ($("#signupForm")) $("#signupForm").hidden = login;

    $("#login-tab")?.classList.toggle("active", login);
    $("#signup-tab")?.classList.toggle("active", !login);

    setAuthMessage("");
  }

  function showConversation(person) {
    activePerson = person;

    $("#empty-chat").hidden = true;
    $("#conversation").hidden = false;

    $("#chat-name").textContent =
      person.display_name || person.username || "Conversation";

    $("#chat-status").textContent =
      person.bio || `@${person.username || "user"}`;

    $("#chat-avatar").src = avatarURL(person);

    $("#voice-call-btn").disabled = false;
    $("#video-call-btn").disabled = false;

    document.body.classList.add("chat-open");

    $$(".person").forEach((button) => {
      button.classList.toggle(
        "active",
        button.dataset.id === person.id
      );
    });
  }

  function $$(selector) {
    return [...document.querySelectorAll(selector)];
  }

  async function getProfile(userId) {
    const { data, error } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", userId)
      .maybeSingle();

    if (error) throw error;

    if (data) return data;

    const metadata = currentUser?.user_metadata || {};

    const fallback = {
      id: userId,
      username: metadata.username || `user_${userId.slice(0, 8)}`,
      display_name: metadata.display_name || "New user",
      bio: "",
      avatar_url: null
    };

    const { data: inserted, error: insertError } = await supabase
      .from("profiles")
      .upsert(fallback, { onConflict: "id" })
      .select()
      .single();

    if (insertError) throw insertError;

    return inserted;
  }

  async function loadProfile() {
    currentProfile = await getProfile(currentUser.id);

    $("#my-name").textContent =
      currentProfile.display_name || currentProfile.username;

    $("#my-username").textContent = `@${currentProfile.username}`;

    $("#my-avatar").src = avatarURL(currentProfile);
    $("#profile-avatar-preview").src = avatarURL(currentProfile);
    $("#profile-display-name").value = currentProfile.display_name || "";
    $("#profile-username").value = currentProfile.username || "";
    $("#profile-bio").value = currentProfile.bio || "";
  }

  async function loadPeople() {
    const list = $("#people-list");
    if (!list) return;

    const { data, error } = await supabase
      .from("profiles")
      .select("id, username, display_name, bio, avatar_url")
      .neq("id", currentUser.id)
      .order("display_name")
      .limit(100);

    if (error) {
      console.error("Unable to load users:", error);
      list.textContent = "Unable to load users. Check database policies.";
      return;
    }

    people = data || [];
    renderPeople();
  }

  function renderPeople() {
    const list = $("#people-list");
    if (!list) return;

    const search = ($("#user-search")?.value || "")
      .trim()
      .toLowerCase();

    const filtered = people.filter((person) => {
      return `${person.display_name || ""} ${person.username || ""}`
        .toLowerCase()
        .includes(search);
    });

    list.replaceChildren();

    if (!filtered.length) {
      const empty = document.createElement("p");
      empty.className = "muted small";
      empty.textContent = "No users found.";
      list.appendChild(empty);
      return;
    }

    filtered.forEach((person) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "person";
      button.dataset.id = person.id;

      const avatar = document.createElement("img");
      avatar.src = avatarURL(person);
      avatar.alt = "";
      avatar.loading = "lazy";

      const details = document.createElement("span");

      const name = document.createElement("strong");
      name.textContent = person.display_name || person.username;

      const username = document.createElement("small");
      username.textContent = `@${person.username}`;

      details.append(name, username);
      button.append(avatar, details);

      button.addEventListener("click", () => openChat(person));

      list.appendChild(button);
    });

    refreshIcons();
  }

  function conversationFilter(personId) {
    return `and(sender_id.eq.${currentUser.id},recipient_id.eq.${personId}),and(sender_id.eq.${personId},recipient_id.eq.${currentUser.id})`;
  }

  async function openChat(person) {
    if (!person || person.id === currentUser.id) return;

    if (activeChannel) {
      await supabase.removeChannel(activeChannel);
      activeChannel = null;
    }

    activePerson = person;
    showConversation(person);

    $("#messages-list").replaceChildren();

    await loadMessages();

    activeChannel = supabase
      .channel(`chat:${[currentUser.id, person.id].sort().join(":")}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages"
        },
        (payload) => {
          const message = payload.new;

          const matches =
            (message.sender_id === currentUser.id &&
             message.recipient_id === activePerson?.id) ||
            (message.sender_id === activePerson?.id &&
             message.recipient_id === currentUser.id);

          if (matches) renderMessage(message);
        }
      )
      .subscribe();
  }

  async function loadMessages() {
    if (!activePerson) return;

    const { data, error } = await supabase
      .from("messages")
      .select("*")
      .or(conversationFilter(activePerson.id))
      .order("created_at", { ascending: true })
      .limit(200);

    if (error) {
      console.error("Message loading error:", error);
      toast("Unable to load messages. Check your messages table and RLS policies.");
      return;
    }

    const list = $("#messages-list");
    list.replaceChildren();

    (data || []).forEach(renderMessage);
    list.scrollTop = list.scrollHeight;
  }

  function renderMessage(message) {
    const list = $("#messages-list");
    if (!list) return;

    if (list.querySelector(`[data-message-id="${CSS.escape(message.id)}"]`)) {
      return;
    }

    const mine = message.sender_id === currentUser.id;
    const wrapper = document.createElement("div");

    wrapper.className = `message ${mine ? "mine" : ""}`;
    wrapper.dataset.messageId = message.id;

    const bubble = document.createElement("div");
    bubble.className = "message-bubble";

    if (message.content) {
      const text = document.createElement("div");
      text.textContent = message.content;
      bubble.appendChild(text);
    }

    if (message.file_url) {
      const link = document.createElement("a");

      link.href = message.file_url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.className = "file-link";
      link.textContent = `📎 ${message.file_name || "Open attachment"}`;

      if (message.file_type?.startsWith("image/")) {
        const image = document.createElement("img");
        image.className = "file-preview";
        image.src = message.file_url;
        image.alt = message.file_name || "Image attachment";
        image.loading = "lazy";
        bubble.appendChild(image);
      }

      bubble.appendChild(link);
    }

    const time = document.createElement("div");
    time.className = "message-time";

    time.textContent = message.created_at
      ? new Date(message.created_at).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit"
        })
      : "";

    wrapper.append(bubble, time);
    list.appendChild(wrapper);

    list.scrollTop = list.scrollHeight;
  }

  async function sendMessage(content = "", attachment = null) {
    if (!activePerson) {
      toast("Select someone to message first.");
      return;
    }

    let fileData = {};

    if (attachment) {
      if (attachment.size > MAX_FILE_SIZE) {
        throw new Error("Files must be 15 MB or smaller.");
      }

      const safeName = attachment.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const path = `${currentUser.id}/${crypto.randomUUID()}-${safeName}`;

      const { error: uploadError } = await supabase.storage
        .from(FILE_BUCKET)
        .upload(path, attachment, {
          upsert: false,
          contentType: attachment.type || "application/octet-stream"
        });

      if (uploadError) throw uploadError;

      const { data: urlData } = supabase.storage
        .from(FILE_BUCKET)
        .getPublicUrl(path);

      fileData = {
        file_url: urlData.publicUrl,
        file_name: attachment.name,
        file_type: attachment.type || "application/octet-stream",
        file_path: path
      };
    }

    const row = {
      sender_id: currentUser.id,
      recipient_id: activePerson.id,
      content: content.trim() || null,
      ...fileData
    };

    const { data, error } = await supabase
      .from("messages")
      .insert(row)
      .select()
      .single();

    if (error) throw error;

    renderMessage(data);
  }

  async function onMessageSubmit(event) {
    event.preventDefault();

    const input = $("#message-input");
    const content = input.value.trim();

    if (!content) return;

    input.disabled = true;

    try {
      await sendMessage(content);
      input.value = "";
    } catch (error) {
      console.error(error);
      toast(error.message || "Message could not be sent.");
    } finally {
      input.disabled = false;
      input.focus();
    }
  }

  async function onFileSelected(event) {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (!file) return;

    try {
      $("#attachment-status").textContent = `Uploading ${file.name}...`;
      await sendMessage("", file);
      $("#attachment-status").textContent = "File sent.";
    } catch (error) {
      console.error(error);
      $("#attachment-status").textContent = "";
      toast(error.message || "File upload failed.");
    }
  }

  async function saveProfile(event) {
    event.preventDefault();

    const displayName = $("#profile-display-name").value.trim();
    const username = $("#profile-username").value.trim();
    const bio = $("#profile-bio").value.trim();
    const file = $("#profile-avatar-file").files?.[0];

    if (!/^[A-Za-z0-9_]{3,24}$/.test(username)) {
      toast("Username must be 3–24 letters, numbers, or underscores.");
      return;
    }

    const changes = {
      id: currentUser.id,
      display_name: displayName,
      username,
      bio
    };

    try {
      if (file) {
        if (file.size > 3 * 1024 * 1024) {
          throw new Error("Profile pictures must be 3 MB or smaller.");
        }

        if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
          throw new Error("Use a JPG, PNG, or WebP image.");
        }

        const extension = file.type === "image/png" ? "png" :
          file.type === "image/webp" ? "webp" : "jpg";

        const path = `${currentUser.id}/${crypto.randomUUID()}.${extension}`;

        const { error: uploadError } = await supabase.storage
          .from(AVATAR_BUCKET)
          .upload(path, file, { contentType: file.type });

        if (uploadError) throw uploadError;

        const { data } = supabase.storage.from(AVATAR_BUCKET).getPublicUrl(path);
        changes.avatar_url = data.publicUrl;
      }

      const { error } = await supabase
        .from("profiles")
        .upsert(changes, { onConflict: "id" });

      if (error) throw error;

      await loadProfile();
      await loadPeople();

      $("#profile-modal").hidden = true;
      toast("Profile updated.");
    } catch (error) {
      console.error(error);
      toast(error.message || "Unable to save profile.");
    }
  }

  /* WEBRTC CALLS */

  async function getLocalMedia(mode) {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Camera and microphone access requires HTTPS.");
    }

    return navigator.mediaDevices.getUserMedia({
      audio: true,
      video: mode === "video"
    });
  }

  function showCallModal(title, status) {
    $("#call-modal").hidden = false;
    $("#call-title").textContent = title;
    $("#call-status").textContent = status;
    refreshIcons();
  }

  async function startCall(mode) {
    if (!activePerson) {
      toast("Select someone to call.");
      return;
    }

    if (callId) {
      toast("A call is already active.");
      return;
    }

    callMode = mode;
    callDirection = "outgoing";
    callId = crypto.randomUUID();
    pendingIce = [];

    try {
      showCallModal(
        `${mode === "video" ? "Video" : "Voice"} call`,
        "Requesting microphone and camera..."
      );

      localStream = await getLocalMedia(mode);
      $("#local-video").srcObject = localStream;
      $("#local-video").hidden = mode !== "video";

      pc = createPeerConnection();

      localStream.getTracks().forEach((track) => {
        pc.addTrack(track, localStream);
      });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const { error } = await supabase.from("call_signals").insert({
        call_id: callId,
        sender_id: currentUser.id,
        recipient_id: activePerson.id,
        kind: "offer",
        payload: {
          sdp: offer.sdp,
          mode
        }
      });

      if (error) throw error;

      $("#incoming-call-actions").hidden = true;
      $("#end-call-btn").hidden = false;

      await subscribeToCall();

      $("#call-status").textContent = `Calling ${activePerson.display_name || activePerson.username}...`;
    } catch (error) {
      console.error("Call start error:", error);
      toast(error.message || "Unable to start call.");
      await endCall(false);
    }
  }

  function createPeerConnection() {
    const connection = new RTCPeerConnection(rtcConfig);

    connection.onicecandidate = async (event) => {
      if (!event.candidate || !callId || !activePerson) return;

      const { error } = await supabase.from("call_signals").insert({
        call_id: callId,
        sender_id: currentUser.id,
        recipient_id: activePerson.id,
        kind: "ice",
        payload: event.candidate.toJSON()
      });

      if (error) console.error("ICE signaling error:", error);
    };

    connection.ontrack = (event) => {
      const stream = event.streams[0];

      if (stream) {
        $("#remote-video").srcObject = stream;
      }

      $("#call-status").textContent = "Connected";
    };

    connection.onconnectionstatechange = () => {
      if (!pc) return;

      if (["failed", "disconnected", "closed"].includes(pc.connectionState)) {
        $("#call-status").textContent = `Connection ${pc.connectionState}`;
      }
    };

    connection.onnegotiationneeded = async () => {
      // Initial offer is created explicitly in startCall().
    };

    return connection;
  }

  async function subscribeToCall() {
    if (!callId || !activePerson) return;

    if (callChannel) {
      await supabase.removeChannel(callChannel);
    }

    callChannel = supabase
      .channel(`call:${callId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "call_signals",
          filter: `call_id=eq.${callId}`
        },
        async (payload) => {
          await handleSignal(payload.new);
        }
      )
      .subscribe();
  }

  async function handleSignal(signal) {
    if (!callId || signal.call_id !== callId) return;
    if (signal.sender_id === currentUser.id) return;

    if (signal.kind === "offer") {
      if (callDirection === "outgoing") return;

      pendingOffer = signal;
      return;
    }

    if (signal.kind === "answer" && pc && callDirection === "outgoing") {
      if (pc.signalingState !== "have-local-offer") return;

      await pc.setRemoteDescription({
        type: "answer",
        sdp: signal.payload.sdp
      });

      for (const candidate of pendingIce) {
        await pc.addIceCandidate(candidate);
      }

      pendingIce = [];
      return;
    }

    if (signal.kind === "ice" && pc && signal.payload) {
      const candidate = new RTCIceCandidate(signal.payload);

      if (pc.remoteDescription) {
        await pc.addIceCandidate(candidate);
      } else {
        pendingIce.push(candidate);
      }

      return;
    }

    if (signal.kind === "hangup") {
      toast("The other person ended the call.");
      await endCall(false);
    }
  }

  async function acceptCall() {
    if (!pendingOffer) {
      toast("No incoming call is available.");
      return;
    }

    const offerSignal = pendingOffer;
    pendingOffer = null;

    callId = offerSignal.call_id;
    callMode = offerSignal.payload.mode || "audio";
    callDirection = "incoming";
    activePerson = people.find((p) => p.id === offerSignal.sender_id) || {
      id: offerSignal.sender_id,
      display_name: "Caller",
      username: "caller"
    };

    try {
      $("#incoming-call-actions").hidden = true;

      localStream = await getLocalMedia(callMode);

      $("#local-video").srcObject = localStream;
      $("#local-video").hidden = callMode !== "video";

      pc = createPeerConnection();

      localStream.getTracks().forEach((track) => {
        pc.addTrack(track, localStream);
      });

      await pc.setRemoteDescription({
        type: "offer",
        sdp: offerSignal.payload.sdp
      });

      for (const candidate of pendingIce) {
        await pc.addIceCandidate(candidate);
      }

      pendingIce = [];

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      const { error } = await supabase.from("call_signals").insert({
        call_id: callId,
        sender_id: currentUser.id,
        recipient_id: activePerson.id,
        kind: "answer",
        payload: { sdp: answer.sdp }
      });

      if (error) throw error;

      await subscribeToCall();

      $("#call-title").textContent =
        `${callMode === "video" ? "Video" : "Voice"} call`;

      $("#call-status").textContent = "Connecting...";
      $("#end-call-btn").hidden = false;
    } catch (error) {
      console.error("Accept call error:", error);
      toast(error.message || "Unable to accept call.");
      await endCall(false);
    }
  }

  async function declineCall() {
    if (pendingOffer) {
      const offer = pendingOffer;
      pendingOffer = null;

      await supabase.from("call_signals").insert({
        call_id: offer.call_id,
        sender_id: currentUser.id,
        recipient_id: offer.sender_id,
        kind: "hangup",
        payload: { reason: "declined" }
      });
    }

    await endCall(false);
  }

  async function endCall(notify = true) {
    const previousCallId = callId;
    const otherId = activePerson?.id;

    if (notify && previousCallId && otherId && currentUser) {
      await supabase.from("call_signals").insert({
        call_id: previousCallId,
        sender_id: currentUser.id,
        recipient_id: otherId,
        kind: "hangup",
        payload: {}
      }).catch(console.error);
    }

    if (callChannel) {
      await supabase.removeChannel(callChannel);
      callChannel = null;
    }

    if (pc) {
      pc.ontrack = null;
      pc.onicecandidate = null;
      pc.close();
      pc = null;
    }

    if (localStream) {
      localStream.getTracks().forEach((track) => track.stop());
      localStream = null;
    }

    $("#local-video").srcObject = null;
    $("#remote-video").srcObject = null;

    $("#call-modal").hidden = true;
    $("#incoming-call-actions").hidden = true;

    callId = null;
    callDirection = null;
    pendingOffer = null;
    pendingIce = [];

    $("#mute-btn").innerHTML = '<i data-lucide="mic"></i>';
    $("#camera-btn").innerHTML = '<i data-lucide="video"></i>';

    refreshIcons();
  }

  async function watchIncomingCalls() {
    if (callWatcher) {
      await supabase.removeChannel(callWatcher);
    }

    callWatcher = supabase
      .channel(`incoming-calls:${currentUser.id}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "call_signals",
          filter: `recipient_id=eq.${currentUser.id}`
        },
        async (payload) => {
          const signal = payload.new;

          if (signal.kind !== "offer") {
            if (signal.call_id === callId) await handleSignal(signal);
            return;
          }

          if (callId) return;

          pendingOffer = signal;
          callId = signal.call_id;
          callMode = signal.payload.mode || "audio";
          callDirection = "incoming";

          const caller = people.find((p) => p.id === signal.sender_id);

          showCallModal(
            `Incoming ${callMode === "video" ? "video" : "voice"} call`,
            `${caller?.display_name || "Someone"} is calling you`
          );

          $("#incoming-call-actions").hidden = false;
          $("#end-call-btn").hidden = true;

          refreshIcons();
        }
      )
      .subscribe();
  }

  async function toggleMute() {
    if (!localStream) return;

    const track = localStream.getAudioTracks()[0];
    if (!track) return;

    track.enabled = !track.enabled;

    $("#mute-btn").title = track.enabled ? "Mute microphone" : "Unmute microphone";
    toast(track.enabled ? "Microphone on" : "Microphone muted");
  }

  async function toggleCamera() {
    if (!localStream) return;

    const track = localStream.getVideoTracks()[0];
    if (!track) {
      toast("This is an audio-only call.");
      return;
    }

    track.enabled = !track.enabled;

    $("#camera-btn").title = track.enabled ? "Turn camera off" : "Turn camera on";
    toast(track.enabled ? "Camera on" : "Camera off");
  }

  async function enterApp(user) {
    currentUser = user;

    showApp();

    try {
      await loadProfile();
    } catch (error) {
      console.error("Profile error:", error);
      toast("Unable to load your profile. Check the profiles table and policies.");
    }

    await loadPeople();
    await watchIncomingCalls();
  }

  async function logout() {
    await endCall(false);

    if (activeChannel) await supabase.removeChannel(activeChannel);
    if (callWatcher) await supabase.removeChannel(callWatcher);

    activeChannel = null;
    callWatcher = null;
    activePerson = null;
    currentProfile = null;
    currentUser = null;

    const { error } = await supabase.auth.signOut();

    if (error) toast(error.message);

    showAuth();
  }

  function bindEvents() {
    $("#login-tab").addEventListener("click", () => setAuthTab("login"));
    $("#signup-tab").addEventListener("click", () => setAuthTab("signup"));

    $("#loginForm").addEventListener("submit", async (event) => {
      event.preventDefault();

      const form = new FormData(event.currentTarget);
      const email = String(form.get("email") || "").trim();
      const password = String(form.get("password") || "");

      const button = event.currentTarget.querySelector("button[type=submit]");
      button.disabled = true;

      try {
        const { data, error } = await supabase.auth.signInWithPassword({
          email,
          password
        });

        if (error) throw error;

        await enterApp(data.user);
      } catch (error) {
        setAuthMessage(error.message || "Unable to log in.");
      } finally {
        button.disabled = false;
      }
    });

    $("#signupForm").addEventListener("submit", async (event) => {
      event.preventDefault();

      const form = new FormData(event.currentTarget);

      const display_name = String(form.get("display_name") || "").trim();
      const username = String(form.get("username") || "").trim();
      const email = String(form.get("email") || "").trim();
      const password = String(form.get("password") || "");

      if (!/^[A-Za-z0-9_]{3,24}$/.test(username)) {
        setAuthMessage("Username must contain 3–24 letters, numbers, or underscores.");
        return;
      }

      try {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: { display_name, username },
            emailRedirectTo: window.location.origin
          }
        });

        if (error) throw error;

        if (data.session && data.user) {
          await enterApp(data.user);
        } else {
          setAuthMessage("Account created. Check your email and confirm your address before logging in.");
        }
      } catch (error) {
        setAuthMessage(error.message || "Unable to create your account.");
      }
    });

    $("#messageForm").addEventListener("submit", onMessageSubmit);
    $("#file-input").addEventListener("change", onFileSelected);

    $("#user-search").addEventListener("input", renderPeople);

    $("#logout-btn").addEventListener("click", logout);

    $("#theme-toggle").addEventListener("click", () => {
      document.body.classList.toggle("dark");

      localStorage.setItem(
        "talkatch-theme",
        document.body.classList.contains("dark") ? "dark" : "light"
      );
    });

    $("#my-account").addEventListener("click", () => {
      $("#profile-modal").hidden = false;
      refreshIcons();
    });

    $("#close-profile-btn").addEventListener("click", () => {
      $("#profile-modal").hidden = true;
    });

    $("#profileForm").addEventListener("submit", saveProfile);

    $("#profile-avatar-file").addEventListener("change", (event) => {
      const file = event.target.files?.[0];
      if (!file) return;

      $("#profile-avatar-preview").src = URL.createObjectURL(file);
    });

    $("#voice-call-btn").addEventListener("click", () => startCall("audio"));
    $("#video-call-btn").addEventListener("click", () => startCall("video"));

    $("#accept-call-btn").addEventListener("click", acceptCall);
    $("#decline-call-btn").addEventListener("click", declineCall);

    $("#end-call-btn").addEventListener("click", () => endCall(true));
    $("#mute-btn").addEventListener("click", toggleMute);
    $("#camera-btn").addEventListener("click", toggleCamera);

    $("#back-to-people").addEventListener("click", () => {
      document.body.classList.remove("chat-open");
    });
  }

  async function init() {
    if (!config.supabaseUrl || !config.supabasePublishableKey ||
        config.supabasePublishableKey.includes("PASTE_YOUR")) {
      showAuth();
      setAuthMessage("Set your Supabase URL and public key in config.js.");
      return;
    }

    if (!window.supabase) {
      showAuth();
      setAuthMessage("Unable to load Supabase. Check your internet connection.");
      return;
    }

    supabase = window.supabase.createClient(
      config.supabaseUrl,
      config.supabasePublishableKey
    );

    bindEvents();

    if (localStorage.getItem("talkatch-theme") === "dark") {
      document.body.classList.add("dark");
    }

    const { data, error } = await supabase.auth.getSession();

    if (error) console.error("Session error:", error);

    if (data?.session?.user) {
      await enterApp(data.session.user);
    } else {
      showAuth();
    }

    supabase.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT") {
        currentUser = null;
        showAuth();
      }
    });

    refreshIcons();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
