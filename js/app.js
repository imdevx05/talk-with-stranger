(() => {
  "use strict";

  const cfg = window.TALKATCH_CONFIG || {};
  const $ = (s, root = document) => root.querySelector(s);

  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));

  const avatar = p => p?.avatar_url ||
    `https://api.dicebear.com/9.x/initials/svg?seed=${encodeURIComponent(
      p?.display_name || p?.username || "Member"
    )}`;

  const time = d => {
    const date = new Date(d);
    return Number.isNaN(date.getTime()) ? "" :
      date.toLocaleString([], {
        month: "short", day: "numeric",
        hour: "numeric", minute: "2-digit"
      });
  };

  const size = n => n < 1048576
    ? `${(n / 1024).toFixed(1)} KB`
    : `${(n / 1048576).toFixed(1)} MB`;

  let db;
  let user = null;
  let profile = null;
  let people = [];
  let activePerson = null;
  let messages = [];
  let messageChannel = null;
  let peopleChannel = null;
  let incomingChannel = null;
  let callChannel = null;
  let pc = null;
  let localStream = null;
  let remoteStream = null;
  let currentCall = null;
  let incomingCall = null;
  let callStartedAt = null;
  let callTimer = null;
  let toastTimer = null;
  let sending = false;

  function toast(message, error = false) {
    const el = $("#toast");
    el.textContent = message;
    el.classList.toggle("error", error);
    el.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add("hidden"), 4500);
  }

  function authMessage(message, error = false) {
    const el = $("#auth-message");
    el.textContent = message;
    el.classList.toggle("error", error);
    el.classList.remove("hidden");
  }

  function showAuth() {
    $("#app-view").classList.add("hidden");
    $("#auth-view").classList.remove("hidden");
  }

  function showApp() {
    $("#auth-view").classList.add("hidden");
    $("#app-view").classList.remove("hidden");
  }

  function showTab(tab) {
    document.querySelectorAll("[data-tab]").forEach(b =>
      b.classList.toggle("active", b.dataset.tab === tab)
    );
    $("#login-form").classList.toggle("hidden", tab !== "login");
    $("#signup-form").classList.toggle("hidden", tab !== "signup");
    $("#auth-title")?.replaceChildren(
      document.createTextNode(tab === "login" ? "Welcome back" : "Join TALKATCH")
    );
    $("#auth-message").classList.add("hidden");
  }

  async function login(form) {
    const data = new FormData(form);
    const { error } = await db.auth.signInWithPassword({
      email: data.get("email").trim(),
      password: data.get("password")
    });

    if (error) return authMessage(error.message, true);
    authMessage("Signed in successfully.");
  }

  async function signup(form) {
    const data = new FormData(form);
    const username = String(data.get("username")).trim().toLowerCase();

    if (!/^[a-z0-9_]{3,24}$/.test(username)) {
      return authMessage(
        "Username must be 3–24 letters, numbers, or underscores.", true
      );
    }

    const { data: result, error } = await db.auth.signUp({
      email: String(data.get("email")).trim(),
      password: data.get("password"),
      options: {
        data: {
          username,
          display_name: String(data.get("display_name")).trim()
        },
        emailRedirectTo: location.origin
      }
    });

    if (error) return authMessage(error.message, true);

    if (result.session) {
      await startApp(result.user);
    } else {
      authMessage(
        "Account created. Check your email and confirm your account before logging in."
      );
    }
  }

  async function resetPassword() {
    const email = $("#login-form").elements.email.value.trim();
    if (!email) return authMessage("Enter your email first.", true);

    const { error } = await db.auth.resetPasswordForEmail(email, {
      redirectTo: location.origin
    });

    if (error) return authMessage(error.message, true);
    authMessage("If the email is registered, a password-reset link will be sent.");
  }

  async function ensureProfile(authUser) {
    const meta = authUser.user_metadata || {};
    const username = String(meta.username ||
      authUser.email?.split("@")[0] || "member")
      .toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 24) || "member";

    const { data: existing, error: readError } = await db
      .from("profiles")
      .select("*")
      .eq("id", authUser.id)
      .maybeSingle();

    if (readError) throw readError;
    if (existing) return existing;

    const { data, error } = await db.from("profiles").insert({
      id: authUser.id,
      username,
      display_name: meta.display_name || username
    }).select("*").single();

    if (error) throw error;
    return data;
  }

  async function startApp(authUser) {
    user = authUser;

    try {
      profile = await ensureProfile(user);
      showApp();
      paintMyProfile();
      await loadPeople();
      subscribePeople();
      subscribeIncomingCalls();
    } catch (e) {
      console.error(e);
      toast("Profile setup failed: " + e.message, true);
    }
  }

  function paintMyProfile() {
    $("#my-avatar").src = avatar(profile);
    $("#my-name").textContent = profile.display_name || profile.username;
    $("#my-handle").textContent = "@" + profile.username;
  }

  async function loadPeople() {
    if (!user) return;

    const { data, error } = await db.from("profiles")
      .select("id,username,display_name,bio,avatar_url,created_at")
      .neq("id", user.id)
      .order("display_name")
      .limit(500);

    if (error) {
      console.error(error);
      toast("Unable to load people: " + error.message, true);
      return;
    }

    people = data || [];
    renderPeople();
  }

  function renderPeople() {
    const query = $("#user-search").value.trim().toLowerCase();
    const list = $("#people-list");

    const filtered = people.filter(p =>
      `${p.username} ${p.display_name} ${p.bio || ""}`
        .toLowerCase().includes(query)
    );

    if (!filtered.length) {
      list.innerHTML = '<p class="muted">No people found.</p>';
      return;
    }

    list.innerHTML = filtered.map(p => `
      <button class="person ${activePerson?.id === p.id ? "active" : ""}"
              type="button" data-person="${esc(p.id)}">
        <img src="${esc(avatar(p))}" alt="">
        <span class="grow">
          <strong>${esc(p.display_name || p.username)}</strong>
          <small>@${esc(p.username)}</small>
        </span>
      </button>
    `).join("");
  }

  function subscribePeople() {
    if (peopleChannel) db.removeChannel(peopleChannel);

    peopleChannel = db.channel("talkatch-profiles")
      .on("postgres_changes", {
        event: "*", schema: "public", table: "profiles"
      }, () => loadPeople())
      .subscribe();
  }

  async function openPerson(id) {
    const person = people.find(p => p.id === id);
    if (!person) return;

    activePerson = person;
    renderPeople();

    $("#chat-title").textContent = person.display_name || person.username;
    $("#chat-subtitle").textContent = "@" + person.username;
    $("#chat-avatar").src = avatar(person);

    $("#message-input").disabled = false;
    $("#send-button").disabled = false;
    $("#file-input").disabled = false;
    $("#voice-call").disabled = false;
    $("#video-call").disabled = false;
    $("#message-input").placeholder =
      `Message ${person.display_name || person.username}...`;

    if (messageChannel) {
      await db.removeChannel(messageChannel);
      messageChannel = null;
    }

    await loadMessages();
    subscribeMessages();
  }

  async function loadMessages() {
    if (!activePerson || !user) return;

    const { data, error } = await db.from("messages")
      .select("id,sender_id,receiver_id,content,attachment_path,attachment_name,attachment_type,attachment_size,created_at")
      .or(
        `and(sender_id.eq.${user.id},receiver_id.eq.${activePerson.id}),` +
        `and(sender_id.eq.${activePerson.id},receiver_id.eq.${user.id})`
      )
      .order("created_at", { ascending: true })
      .limit(300);

    if (error) {
      console.error(error);
      toast("Unable to load messages: " + error.message, true);
      return;
    }

    messages = data || [];
    await renderMessages();
  }

  function subscribeMessages() {
    const peerId = activePerson.id;

    messageChannel = db.channel(
      `messages:${[user.id, peerId].sort().join(":")}`
    ).on("postgres_changes", {
      event: "INSERT", schema: "public", table: "messages"
    }, async payload => {
      const m = payload.new;

      if (!activePerson || activePerson.id !== peerId) return;

      const relevant =
        (m.sender_id === user.id && m.receiver_id === peerId) ||
        (m.sender_id === peerId && m.receiver_id === user.id);

      if (relevant && !messages.some(x => x.id === m.id)) {
        messages.push(m);
        messages.sort((a, b) =>
          new Date(a.created_at) - new Date(b.created_at)
        );
        await renderMessages();
      }
    }).subscribe();
  }

  async function renderMessages() {
    const box = $("#messages");

    if (!messages.length) {
      box.innerHTML =
        '<div class="welcome"><h2>Say hello</h2><p>No messages yet.</p></div>';
      return;
    }

    const rows = await Promise.all(messages.map(async m => {
      const mine = m.sender_id === user.id;
      let content = esc(m.content || "");

      if (m.attachment_path) {
        const { data, error } = await db.storage
          .from("message-files")
          .createSignedUrl(m.attachment_path, 3600);

        if (!error && data?.signedUrl) {
          content += `<a class="attachment" href="${esc(data.signedUrl)}"
            target="_blank" rel="noopener noreferrer">
            ${esc(m.attachment_name || "Download attachment")}
            <br><small>${esc(m.attachment_size ? size(m.attachment_size) : "File")}</small>
          </a>`;
        } else {
          content += `<p class="attachment">${esc(m.attachment_name || "Attachment unavailable")}</p>`;
        }
      }

      const person = mine ? profile : activePerson;

      return `<article class="message-row ${mine ? "mine" : ""}">
        <img src="${esc(avatar(person))}" alt="">
        <div class="message-content">
          <div class="message-author">${mine ? "You" :
            esc(activePerson.display_name || activePerson.username)}</div>
          <div class="bubble">${content}</div>
          <div class="message-time">${esc(time(m.created_at))}</div>
        </div>
      </article>`;
    }));

    box.innerHTML = rows.join("");
    box.scrollTop = box.scrollHeight;
  }

  async function sendMessage() {
    if (!activePerson || sending) return;

    const content = $("#message-input").value.trim();
    const file = $("#file-input").files[0];

    if (!content && !file) return;

    sending = true;
    $("#send-button").disabled = true;

    try {
      const attachment = {};

      if (file) {
        if (file.size > (cfg.maxFileBytes || 15 * 1024 * 1024)) {
          throw new Error("Maximum attachment size is 15 MB.");
        }

        const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
        const path = `${user.id}/${crypto.randomUUID()}-${safeName}`;

        const { error: uploadError } = await db.storage
          .from("message-files")
          .upload(path, file, {
            contentType: file.type || "application/octet-stream",
            upsert: false
          });

        if (uploadError) throw uploadError;

        attachment.attachment_path = path;
        attachment.attachment_name = file.name;
        attachment.attachment_type = file.type || "application/octet-stream";
        attachment.attachment_size = file.size;
      }

      const { data, error } = await db.from("messages").insert({
        sender_id: user.id,
        receiver_id: activePerson.id,
        content,
        ...attachment
      }).select("*").single();

      if (error) throw error;

      if (!messages.some(m => m.id === data.id)) {
        messages.push(data);
        await renderMessages();
      }

      $("#message-input").value = "";
      $("#file-input").value = "";
      $("#message-input").style.height = "auto";
    } catch (e) {
      console.error(e);
      toast("Could not send message: " + e.message, true);
    } finally {
      sending = false;
      $("#send-button").disabled = !activePerson;
    }
  }

  async function uploadAvatar(file) {
    if (!user || !file) return;

    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      return toast("Use a JPG, PNG, or WebP image.", true);
    }

    if (file.size > 3 * 1024 * 1024) {
      return toast("Profile picture must be 3 MB or smaller.", true);
    }

    try {
      const extension = file.type === "image/png" ? "png" :
        file.type === "image/webp" ? "webp" : "jpg";

      const path = `${user.id}/${crypto.randomUUID()}.${extension}`;

      const { error: uploadError } = await db.storage.from("avatars")
        .upload(path, file, { contentType: file.type, upsert: false });

      if (uploadError) throw uploadError;

      const { data: publicData } = db.storage.from("avatars").getPublicUrl(path);

      const { data, error } = await db.from("profiles")
        .update({ avatar_url: publicData.publicUrl })
        .eq("id", user.id)
        .select("*")
        .single();

      if (error) throw error;

      profile = data;
      paintMyProfile();
      toast("Profile picture updated.");
    } catch (e) {
      console.error(e);
      toast("Avatar upload failed: " + e.message, true);
    }
  }

  function openProfileDialog() {
    const form = $("#profile-form");
    form.elements.display_name.value = profile.display_name || "";
    form.elements.username.value = profile.username || "";
    form.elements.bio.value = profile.bio || "";
    $("#profile-dialog").showModal();
  }

  async function saveProfile(form) {
    const data = new FormData(form);
    const username = String(data.get("username")).trim().toLowerCase();

    if (!/^[a-z0-9_]{3,24}$/.test(username)) {
      return toast("Username must be 3–24 letters, numbers, or underscores.", true);
    }

    const { data: updated, error } = await db.from("profiles")
      .update({
        username,
        display_name: String(data.get("display_name")).trim(),
        bio: String(data.get("bio") || "").trim()
      })
      .eq("id", user.id)
      .select("*")
      .single();

    if (error) return toast("Profile update failed: " + error.message, true);

    profile = updated;
    paintMyProfile();
    $("#profile-dialog").close();
    await loadPeople();
    toast("Profile saved.");
  }

  async function logout() {
    await finishCall(false);

    if (messageChannel) await db.removeChannel(messageChannel);
    if (peopleChannel) await db.removeChannel(peopleChannel);
    if (incomingChannel) await db.removeChannel(incomingChannel);

    const { error } = await db.auth.signOut();
    if (error) return toast(error.message, true);

    user = profile = activePerson = null;
    messages = [];
    people = [];
    showAuth();
  }

  // WebRTC calling: the remote peer must be online and have this app open.
  // A TURN server may be required on restrictive networks.
  function newCallId() {
    return crypto.randomUUID();
  }

  async function sendToUser(to, event, payload) {
    const channel = db.channel(`calls:${to}`, {
      config: { broadcast: { self: false } }
    });

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Call signaling timed out.")), 10000);

      channel.subscribe(status => {
        if (status === "SUBSCRIBED") {
          clearTimeout(timeout);
          channel.send({ type: "broadcast", event, payload })
            .then(resolve).catch(reject);
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          clearTimeout(timeout);
          reject(new Error("Could not connect to call signaling."));
        }
      });
    });

    setTimeout(() => db.removeChannel(channel), 2000);
  }

  function subscribeIncomingCalls() {
    if (incomingChannel) db.removeChannel(incomingChannel);

    incomingChannel = db.channel(`calls:${user.id}`, {
      config: { broadcast: { self: false } }
    }).on("broadcast", { event: "invite" }, ({ payload }) => {
      if (!payload || payload.to !== user.id || currentCall) return;

      incomingCall = payload;
      const person = people.find(p => p.id === payload.from);
      if (person) activePerson = person;

      $("#call-banner").classList.remove("hidden");
      $("#call-status").textContent =
        `Incoming ${payload.type === "video" ? "video" : "voice"} call`;
      $("#call-detail").textContent = `${payload.fromName || "Someone"} is calling.`;
      $("#accept-call").classList.remove("hidden");
      $("#decline-call").classList.remove("hidden");
      $("#end-call").classList.add("hidden");
    }).on("broadcast", { event: "cancel" }, ({ payload }) => {
      if (incomingCall?.callId === payload?.callId) {
        incomingCall = null;
        $("#call-banner").classList.add("hidden");
      }
    }).subscribe();
  }

  async function setupCallChannel() {
    if (callChannel) await db.removeChannel(callChannel);

    callChannel = db.channel(`call-session:${currentCall.callId}`, {
      config: { broadcast: { self: false } }
    }).on("broadcast", { event: "signal" }, async ({ payload }) => {
      if (!payload || payload.from === user.id ||
          payload.callId !== currentCall?.callId) return;

      try {
        if (payload.description) {
          await pc.setRemoteDescription(payload.description);

          if (payload.description.type === "offer") {
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            await sendSignal({ description: pc.localDescription });
          }
        }

        if (payload.candidate) {
          await pc.addIceCandidate(payload.candidate);
        }
      } catch (e) {
        console.error(e);
        toast("Call signaling error: " + e.message, true);
      }
    }).on("broadcast", { event: "accepted" }, async ({ payload }) => {
      if (currentCall?.role !== "caller" ||
          payload?.callId !== currentCall.callId) return;

      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await sendSignal({ description: pc.localDescription });
      } catch (e) {
        toast("Could not create call offer: " + e.message, true);
      }
    }).on("broadcast", { event: "ended" }, ({ payload }) => {
      if (payload?.callId === currentCall?.callId) finishCall(false);
    }).subscribe(async status => {
      if (status === "SUBSCRIBED" && currentCall?.role === "callee") {
        await sendSignal({ accepted: true });
      }
    });
  }

  async function sendSignal(extra) {
    if (!callChannel || !currentCall) return;

    await callChannel.send({
      type: "broadcast",
      event: extra.accepted ? "accepted" : extra.ended ? "ended" : "signal",
      payload: { ...extra, callId: currentCall.callId, from: user.id }
    });
  }

  async function prepareCallMedia(type) {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Camera/microphone access requires HTTPS or localhost.");
    }

    // The browser will ask the user for camera and microphone permission.
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: type === "video"
    });

    remoteStream = new MediaStream();
    $("#local-video").srcObject = localStream;
    $("#remote-video").srcObject = remoteStream;

    pc = new RTCPeerConnection({
      iceServers: cfg.iceServers || [
        { urls: "stun:stun.l.google.com:19302" }
      ]
    });

    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

    pc.ontrack = event => {
      event.streams[0]?.getTracks().forEach(track => remoteStream.addTrack(track));
      $("#remote-video").srcObject = remoteStream;
    };

    pc.onicecandidate = event => {
      if (event.candidate) {
        sendSignal({ candidate: event.candidate.toJSON() });
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc && ["failed", "disconnected"].includes(pc.connectionState)) {
        toast("Call connection interrupted. A TURN server may be needed.", true);
      }
    };

    $("#call-stage").classList.remove("hidden");
    callStartedAt = Date.now();

    clearInterval(callTimer);
    callTimer = setInterval(() => {
      if (!callStartedAt) return;
      const seconds = Math.floor((Date.now() - callStartedAt) / 1000);
      $("#call-clock").textContent =
        `${String(Math.floor(seconds / 60)).padStart(2, "0")}:` +
        `${String(seconds % 60).padStart(2, "0")}`;
    }, 1000);
  }

  async function startCall(type) {
    if (!activePerson) return toast("Choose someone first.", true);
    if (currentCall) return toast("A call is already active.", true);

    currentCall = {
      callId: newCallId(),
      type,
      role: "caller",
      peerId: activePerson.id,
      peerName: activePerson.display_name || activePerson.username
    };

    try {
      await setupCallChannel();
      await prepareCallMedia(type);

      await sendToUser(activePerson.id, "invite", {
        callId: currentCall.callId,
        type,
        from: user.id,
        to: activePerson.id,
        fromName: profile.display_name || profile.username
      });

      $("#call-banner").classList.remove("hidden");
      $("#call-status").textContent = "Calling...";
      $("#call-detail").textContent = `Waiting for ${currentCall.peerName}.`;
      $("#accept-call").classList.add("hidden");
      $("#decline-call").classList.add("hidden");
      $("#end-call").classList.remove("hidden");
    } catch (e) {
      toast("Could not start call: " + e.message, true);
      await finishCall(false);
    }
  }

  async function acceptCall() {
    if (!incomingCall) return;

    const c = incomingCall;
    currentCall = {
      ...c,
      role: "callee",
      peerId: c.from,
      peerName: c.fromName || "Member"
    };
    incomingCall = null;

    try {
      $("#call-banner").classList.add("hidden");
      await setupCallChannel();
      await prepareCallMedia(c.type);

      $("#call-banner").classList.remove("hidden");
      $("#call-status").textContent = "Connected";
      $("#call-detail").textContent = `In a call with ${currentCall.peerName}.`;
      $("#accept-call").classList.add("hidden");
      $("#decline-call").classList.add("hidden");
      $("#end-call").classList.remove("hidden");
    } catch (e) {
      toast("Could not accept call: " + e.message, true);
      await finishCall(false);
    }
  }

  async function declineCall() {
    if (incomingCall) {
      try {
        await sendToUser(incomingCall.from, "cancel", {
          callId: incomingCall.callId,
          from: user.id
        });
      } catch (e) {
        console.warn(e);
      }
    }

    incomingCall = null;
    $("#call-banner").classList.add("hidden");
  }

  async function finishCall(notify = true) {
    const old = currentCall;

    if (notify && old) {
      try {
        await sendSignal({ ended: true });
      } catch (e) {
        console.warn(e);
      }
    }

    currentCall = null;
    incomingCall = null;
    callStartedAt = null;
    clearInterval(callTimer);

    if (pc) {
      pc.close();
      pc = null;
    }

    localStream?.getTracks().forEach(t => t.stop());
    remoteStream?.getTracks().forEach(t => t.stop());
    localStream = remoteStream = null;

    $("#local-video").srcObject = null;
    $("#remote-video").srcObject = null;
    $("#call-stage").classList.add("hidden");
    $("#call-banner").classList.add("hidden");

    if (callChannel) {
      await db.removeChannel(callChannel);
      callChannel = null;
    }
  }

  function toggleMute() {
    const track = localStream?.getAudioTracks()[0];
    if (!track) return;

    track.enabled = !track.enabled;
    $("#mute-call").textContent = track.enabled ? "Mute mic" : "Unmute mic";
  }

  function toggleCamera() {
    const track = localStream?.getVideoTracks()[0];
    if (!track) return;

    track.enabled = !track.enabled;
    $("#camera-call").textContent = track.enabled ? "Camera off" : "Camera on";
  }

  function wire() {
    document.querySelectorAll("[data-tab]").forEach(b =>
      b.addEventListener("click", () => showTab(b.dataset.tab))
    );

    $("#login-form").addEventListener("submit", e => {
      e.preventDefault();
      login(e.currentTarget);
    });

    $("#signup-form").addEventListener("submit", e => {
      e.preventDefault();
      signup(e.currentTarget);
    });

    $("#forgot-password").addEventListener("click", resetPassword);
    $("#logout-button").addEventListener("click", logout);
    $("#refresh-users")?.addEventListener("click", loadPeople);

    $("#people-list").addEventListener("click", e => {
      const button = e.target.closest("[data-person]");
      if (button) openPerson(button.dataset.person);
    });

    $("#user-search").addEventListener("input", renderPeople);

    $("#my-avatar").addEventListener("click", () => $("#avatar-upload").click());

    $("#avatar-upload").addEventListener("change", e => {
      if (e.target.files?.[0]) uploadAvatar(e.target.files[0]);
      e.target.value = "";
    });

    $("#message-form").addEventListener("submit", e => {
      e.preventDefault();
      sendMessage();
    });

    $("#message-input").addEventListener("keydown", e => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        $("#message-form").requestSubmit();
      }
    });

    $("#message-input").addEventListener("input", e => {
      e.target.style.height = "auto";
      e.target.style.height = Math.min(e.target.scrollHeight, 130) + "px";
    });

    $("#file-input").addEventListener("change", e => {
      const file = e.target.files?.[0];
      if (file) toast(`Selected ${file.name} (${size(file.size)}). Press Send.`);
    });

    $("#theme-button").addEventListener("click", () => {
      const next = document.body.dataset.theme === "light" ? "dark" : "light";
      document.body.dataset.theme = next;
      localStorage.setItem("talkatch-theme", next);
    });

    $("#edit-profile").addEventListener("click", openProfileDialog);
    $("#close-profile").addEventListener("click", () => $("#profile-dialog").close());

    $("#profile-form").addEventListener("submit", e => {
      e.preventDefault();
      saveProfile(e.currentTarget);
    });

    $("#voice-call").addEventListener("click", () => startCall("audio"));
    $("#video-call").addEventListener("click", () => startCall("video"));
    $("#accept-call").addEventListener("click", acceptCall);
    $("#decline-call").addEventListener("click", declineCall);
    $("#end-call").addEventListener("click", () => finishCall(true));
    $("#hangup-call").addEventListener("click", () => finishCall(true));
    $("#mute-call").addEventListener("click", toggleMute);
    $("#camera-call").addEventListener("click", toggleCamera);

    const theme = localStorage.getItem("talkatch-theme");
    if (theme) document.body.dataset.theme = theme;
  }

  async function init() {
    wire();

    if (!cfg.supabaseUrl ||
        !cfg.supabaseAnonKey ||
        cfg.supabaseAnonKey.includes("PASTE_YOUR")) {
      authMessage("Open config.js and add your Supabase publishable/anon key.", true);
      return;
    }

    if (!window.supabase?.createClient) {
      authMessage("Supabase failed to load. Check your internet connection.", true);
      return;
    }

    db = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);

    const { data, error } = await db.auth.getSession();
    if (error) {
      authMessage(error.message, true);
      return;
    }

    if (data.session?.user) await startApp(data.session.user);
    else showAuth();

    db.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_IN" && session?.user && user?.id !== session.user.id) {
        setTimeout(() => startApp(session.user), 0);
      }

      if (event === "SIGNED_OUT") {
        user = profile = activePerson = null;
        showAuth();
      }
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
