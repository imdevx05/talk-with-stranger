(() => {
  "use strict";

  // =========================================================
  // TALKATCH — Application JavaScript
  // Requires: index.html, style.css, config.js, Supabase JS v2
  // =========================================================

  const cfg = window.TALKATCH_CONFIG || {};

  const $ = (selector, root = document) =>
    root.querySelector(selector);

  const esc = value =>
    String(value ?? "").replace(/[&<>"']/g, char => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[char]);

  const fmtTime = value => {
    const date = new Date(value);

    if (Number.isNaN(date.getTime())) return "";

    return date.toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit"
    });
  };

  const fmtSize = bytes => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;

    return `${(bytes / 1048576).toFixed(1)} MB`;
  };

  const avatar = person =>
    person?.avatar_url ||
    `https://api.dicebear.com/9.x/initials/svg?seed=${encodeURIComponent(
      person?.display_name || person?.username || "Member"
    )}`;

  let db = null;

  let user = null;
  let profile = null;
  let people = [];
  let activePerson = null;
  let messages = [];

  let messageChannel = null;
  let incomingChannel = null;
  let callChannel = null;

  let pc = null;
  let localStream = null;
  let remoteStream = null;

  let currentCall = null;
  let incomingCall = null;

  let callStartedAt = null;
  let callTimer = null;
  let typingTimer = null;
  let typingOffTimer = null;
  let toastTimer = null;

  let sending = false;
  let appStarting = false;

  // =========================================================
  // NOTIFICATIONS / UI HELPERS
  // =========================================================

  function toast(message, isError = false) {
    const element = $("#toast");

    if (!element) {
      console[isError ? "error" : "log"](message);
      return;
    }

    element.textContent = message;
    element.classList.toggle("error", isError);
    element.classList.remove("hidden");

    clearTimeout(toastTimer);

    toastTimer = setTimeout(() => {
      element.classList.add("hidden");
    }, 4200);
  }

  function authMessage(message, isError = false) {
    const element = $("#auth-message");

    if (!element) return;

    element.textContent = message;
    element.classList.toggle("error", isError);
    element.classList.remove("hidden");
  }

  function setBusy(form, busy) {
    const button = $('button[type="submit"]', form);

    if (!button) return;

    if (!button.dataset.originalText) {
      button.dataset.originalText = button.textContent;
    }

    button.disabled = busy;

    button.textContent = busy
      ? "Please wait…"
      : button.dataset.originalText;
  }

  function showAuth() {
    $("#auth-view").classList.remove("hidden");
    $("#app-view").classList.add("hidden");
  }

  function showApp() {
    $("#auth-view").classList.add("hidden");
    $("#app-view").classList.remove("hidden");
  }

  function showTab(tab) {
    const signup = tab === "signup";

    $("#login-form").classList.toggle("hidden", signup);
    $("#signup-form").classList.toggle("hidden", !signup);

    document.querySelectorAll("[data-tab]").forEach(button => {
      button.classList.toggle("active", button.dataset.tab === tab);
    });

    $("#auth-title").textContent = signup
      ? "Create your account"
      : "Welcome back";

    $("#auth-message").classList.add("hidden");
  }

  function resetChatUI() {
    activePerson = null;
    messages = [];

    $("#chat-title").textContent = "Choose a person";
    $("#chat-subtitle").textContent =
      "Select someone from the left to start a conversation.";

    $("#chat-avatar").src =
      "https://api.dicebear.com/9.x/initials/svg?seed=Talkatch";

    $("#voice-call").disabled = true;
    $("#video-call").disabled = true;
    $("#message-input").disabled = true;
    $("#send-button").disabled = true;
    $("#file-input").disabled = true;

    $("#message-input").value = "";
    $("#message-input").placeholder = "Choose a person first…";

    $("#typing-indicator").classList.add("hidden");

    welcomeMessages();
    renderPeople();
  }

  // =========================================================
  // AUTHENTICATION
  // =========================================================

  async function login(form) {
    setBusy(form, true);

    try {
      const formData = new FormData(form);

      const email = String(formData.get("email") || "")
        .trim()
        .toLowerCase();

      const password = String(formData.get("password") || "");

      const { data, error } = await db.auth.signInWithPassword({
        email,
        password
      });

      if (error) throw error;

      if (!data.user) {
        throw new Error("Login did not return a user.");
      }

      await startApp(data.user);
    } catch (error) {
      authMessage(error.message || "Unable to log in.", true);
    } finally {
      setBusy(form, false);
    }
  }

  async function signup(form) {
    setBusy(form, true);

    try {
      const formData = new FormData(form);

      const username = String(formData.get("username") || "")
        .trim()
        .toLowerCase();

      const displayName = String(formData.get("display_name") || "")
        .trim();

      const email = String(formData.get("email") || "")
        .trim()
        .toLowerCase();

      const password = String(formData.get("password") || "");

      if (!/^[a-z0-9_]{3,24}$/.test(username)) {
        throw new Error(
          "Username must be 3–24 characters using letters, numbers, or underscores."
        );
      }

      if (!displayName) {
        throw new Error("Please enter your display name.");
      }

      if (password.length < 8) {
        throw new Error("Password must be at least 8 characters.");
      }

      const { data, error } = await db.auth.signUp({
        email,
        password,
        options: {
          data: {
            username,
            display_name: displayName
          },
          emailRedirectTo: location.origin
        }
      });

      if (error) throw error;

      if (data.session && data.user) {
        await startApp(data.user);
      } else {
        form.reset();

        authMessage(
          "Account created. Check your email and confirm your address before logging in."
        );
      }
    } catch (error) {
      authMessage(
        error.message || "Unable to create your account.",
        true
      );
    } finally {
      setBusy(form, false);
    }
  }

  async function requestPasswordReset() {
    const email = prompt(
      "Enter the email address associated with your TALKATCH account:"
    );

    if (!email) return;

    try {
      const normalizedEmail = email.trim().toLowerCase();

      if (!normalizedEmail.includes("@")) {
        throw new Error("Enter a valid email address.");
      }

      const { error } = await db.auth.resetPasswordForEmail(
        normalizedEmail,
        {
          redirectTo: `${location.origin}${location.pathname}?resetPassword=true`
        }
      );

      if (error) throw error;

      authMessage(
        "If the email belongs to an account, password reset instructions will be sent. Check your inbox."
      );
    } catch (error) {
      authMessage(
        error.message || "Could not request a password reset.",
        true
      );
    }
  }

  async function changePassword(newPassword) {
    if (!newPassword || newPassword.length < 8) {
      throw new Error("Password must be at least 8 characters.");
    }

    const { error } = await db.auth.updateUser({
      password: newPassword
    });

    if (error) throw error;
  }

  // =========================================================
  // PROFILES
  // =========================================================

  async function getProfile(authUser) {
    const { data, error } = await db
      .from("profiles")
      .select("id,username,display_name,bio,avatar_url")
      .eq("id", authUser.id)
      .maybeSingle();

    if (error) throw error;

    if (data) return data;

    const metadata = authUser.user_metadata || {};

    const base = String(
      metadata.username ||
      authUser.email?.split("@")[0] ||
      "member"
    )
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "")
      .slice(0, 18) || "member";

    const row = {
      id: authUser.id,
      username: `${base}_${authUser.id.replace(/-/g, "").slice(0, 5)}`,
      display_name: metadata.display_name || base,
      bio: "",
      avatar_url: null
    };

    const result = await db
      .from("profiles")
      .upsert(row, { onConflict: "id" })
      .select("id,username,display_name,bio,avatar_url")
      .single();

    if (result.error) throw result.error;

    return result.data;
  }

  function renderSelf() {
    if (!profile) return;

    $("#my-avatar").src = avatar(profile);

    $("#my-name").textContent =
      profile.display_name || profile.username || "Member";

    $("#my-handle").textContent =
      `@${profile.username || "member"}`;
  }

  async function uploadAvatar(file) {
    if (!user || !profile || !file) return;

    const allowedTypes = [
      "image/jpeg",
      "image/png",
      "image/webp"
    ];

    if (!allowedTypes.includes(file.type)) {
      toast("Choose a JPG, PNG, or WebP image.", true);
      return;
    }

    if (file.size > 3 * 1024 * 1024) {
      toast("Profile pictures must be 3 MB or smaller.", true);
      return;
    }

    try {
      const extensions = {
        "image/jpeg": "jpg",
        "image/png": "png",
        "image/webp": "webp"
      };

      const extension = extensions[file.type];

      const path =
        `${user.id}/${crypto.randomUUID()}.${extension}`;

      const { data, error } = await db.storage
        .from("avatars")
        .upload(path, file, {
          contentType: file.type,
          upsert: false,
          cacheControl: "3600"
        });

      if (error) throw error;

      const publicUrl = db.storage
        .from("avatars")
        .getPublicUrl(data.path)
        .data.publicUrl;

      const { data: updated, error: updateError } = await db
        .from("profiles")
        .update({ avatar_url: publicUrl })
        .eq("id", user.id)
        .select("id,username,display_name,bio,avatar_url")
        .single();

      if (updateError) throw updateError;

      profile = updated;

      renderSelf();
      renderPeople();

      toast("Profile picture updated.");
    } catch (error) {
      console.error("Avatar upload failed:", error);

      toast(
        `Avatar upload failed: ${error.message}. Check the avatars bucket and its storage policies.`,
        true
      );
    }
  }

  // =========================================================
  // APPLICATION STARTUP / LOGOUT
  // =========================================================

  async function startApp(authUser) {
    if (appStarting) return;

    appStarting = true;
    user = authUser;

    try {
      profile = await getProfile(authUser);

      showApp();
      renderSelf();

      await loadPeople();
      subscribeIncomingCalls();
    } catch (error) {
      console.error("Application startup failed:", error);

      toast(
        `Unable to load your profile: ${error.message}`,
        true
      );
    } finally {
      appStarting = false;
    }
  }

  async function logout() {
    try {
      await finishCall(false);

      if (messageChannel) {
        await db.removeChannel(messageChannel);
        messageChannel = null;
      }

      if (incomingChannel) {
        await db.removeChannel(incomingChannel);
        incomingChannel = null;
      }

      const { error } = await db.auth.signOut();

      if (error) throw error;

      user = null;
      profile = null;
      people = [];

      resetChatUI();
      showAuth();
      showTab("login");
    } catch (error) {
      toast(`Logout failed: ${error.message}`, true);
    }
  }

  // =========================================================
  // MEMBER SEARCH
  // =========================================================

  async function loadPeople() {
    if (!user) return;

    const list = $("#people-list");

    list.innerHTML =
      '<div class="empty-small">Loading members…</div>';

    const { data, error } = await db
      .from("profiles")
      .select("id,username,display_name,bio,avatar_url")
      .neq("id", user.id)
      .order("display_name", { ascending: true })
      .limit(300);

    if (error) {
      console.error("Could not load members:", error);

      list.innerHTML =
        '<div class="empty-small">Could not load members. Check the profiles table and its RLS policies.</div>';

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

    const filtered = people.filter(person => {
      const text =
        `${person.display_name || ""} ${person.username || ""}`
          .toLowerCase();

      return text.includes(search);
    });

    if (!filtered.length) {
      list.innerHTML =
        '<div class="empty-small">No members found. Ask a friend to create an account.</div>';

      return;
    }

    list.innerHTML = filtered.map(person => `
      <button
        class="person ${activePerson?.id === person.id ? "active" : ""}"
        data-person="${esc(person.id)}"
        type="button"
      >
        <img src="${esc(avatar(person))}" alt="">

        <span class="person-meta">
          <strong>${esc(person.display_name || person.username || "Member")}</strong>
          <small>@${esc(person.username || "member")}</small>
        </span>

        <span class="person-status" title="Member"></span>
      </button>
    `).join("");
  }

  function welcomeMessages() {
    $("#messages").innerHTML = `
      <div class="welcome">
        <div class="welcome-icon">✦</div>
        <h2>Your conversations start here</h2>
        <p>
          Choose a person to send a message, share a file,
          or start a voice/video call.
        </p>
      </div>
    `;
  }

  // =========================================================
  // DIRECT MESSAGES
  // =========================================================

  async function openPerson(personId) {
    const person = people.find(item => item.id === personId);

    if (!person) return;

    if (activePerson?.id === personId) return;

    activePerson = person;
    messages = [];

    renderPeople();

    $("#chat-title").textContent =
      person.display_name || person.username || "Member";

    $("#chat-subtitle").textContent =
      `@${person.username || "member"}`;

    $("#chat-avatar").src = avatar(person);

    $("#voice-call").disabled = false;
    $("#video-call").disabled = false;
    $("#message-input").disabled = false;
    $("#send-button").disabled = false;
    $("#file-input").disabled = false;

    $("#message-input").placeholder =
      `Message ${person.display_name || person.username || "member"}…`;

    if (messageChannel) {
      await db.removeChannel(messageChannel);
      messageChannel = null;
    }

    await loadMessages();

    if (activePerson?.id === personId) {
      subscribeMessages();
    }
  }

  async function loadMessages() {
    if (!user || !activePerson) return;

    const personId = activePerson.id;

    $("#messages").innerHTML =
      '<div class="welcome"><h2>Loading messages…</h2></div>';

    const { data, error } = await db
      .from("messages")
      .select(`
        id,
        sender_id,
        receiver_id,
        content,
        attachment_path,
        attachment_name,
        attachment_type,
        attachment_size,
        created_at
      `)
      .or(
        `and(sender_id.eq.${user.id},receiver_id.eq.${personId}),and(sender_id.eq.${personId},receiver_id.eq.${user.id})`
      )
      .order("created_at", { ascending: true })
      .limit(300);

    if (error) {
      console.error("Could not load messages:", error);

      $("#messages").innerHTML = `
        <div class="welcome">
          <h2>Could not load messages</h2>
          <p>${esc(error.message)}</p>
          <p>Check your messages table and its row-level security policies.</p>
        </div>
      `;

      return;
    }

    if (activePerson?.id !== personId) return;

    messages = data || [];

    await renderMessages();
  }

  function subscribeMessages() {
    if (!user || !activePerson) return;

    const personId = activePerson.id;

    messageChannel = db
      .channel(
        `messages:${[user.id, personId].sort().join(":")}`,
        {
          config: {
            broadcast: { self: false }
          }
        }
      )
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages"
        },
        async payload => {
          const message = payload.new;

          if (!message) return;

          const relevant =
            (
              message.sender_id === user.id &&
              message.receiver_id === personId
            ) ||
            (
              message.sender_id === personId &&
              message.receiver_id === user.id
            );

          if (!relevant) return;

          if (!messages.some(item => item.id === message.id)) {
            messages.push(message);

            messages.sort(
              (a, b) =>
                new Date(a.created_at) - new Date(b.created_at)
            );

            if (activePerson?.id === personId) {
              await renderMessages();
            }
          }
        }
      )
      .on(
        "broadcast",
        { event: "typing" },
        ({ payload }) => {
          if (payload?.userId !== activePerson?.id) return;

          $("#typing-indicator").classList.remove("hidden");

          clearTimeout(typingOffTimer);

          typingOffTimer = setTimeout(() => {
            $("#typing-indicator").classList.add("hidden");
          }, 1600);
        }
      )
      .subscribe(status => {
        if (status === "CHANNEL_ERROR") {
          console.error("Message realtime channel failed.");
        }
      });
  }

  async function renderMessages() {
    const box = $("#messages");

    if (!messages.length) {
      box.innerHTML = `
        <div class="welcome">
          <div class="welcome-icon">✦</div>
          <h2>Say hello</h2>
          <p>No messages yet. Send the first message below.</p>
        </div>
      `;

      return;
    }

    const currentPerson = activePerson;

    const rendered = await Promise.all(
      messages.map(async message => {
        const mine = message.sender_id === user.id;

        let body = esc(message.content || "");

        if (message.attachment_path) {
          let href = "";

          try {
            const { data, error } = await db.storage
              .from("message-files")
              .createSignedUrl(message.attachment_path, 3600);

            if (!error && data?.signedUrl) {
              href = data.signedUrl;
            }
          } catch (error) {
            console.error("Could not create attachment link:", error);
          }

          const fileName = message.attachment_name || "Shared file";

          if (href) {
            body += `
              ${body ? "<br>" : ""}
              <a
                class="attachment"
                href="${esc(href)}"
                target="_blank"
                rel="noopener noreferrer"
              >
                <span class="file-icon">↧</span>
                <span>
                  <strong>${esc(fileName)}</strong>
                  <small>
                    ${esc(
                      message.attachment_size
                        ? fmtSize(message.attachment_size)
                        : message.attachment_type || "Attachment"
                    )}
                    · link expires in 1 hour
                  </small>
                </span>
              </a>
            `;
          } else {
            body += `
              <div class="attachment">
                <span class="file-icon">↧</span>
                <span>
                  <strong>${esc(fileName)}</strong>
                  <small>Attachment link unavailable.</small>
                </span>
              </div>
            `;
          }
        }

        return `
          <article class="message-row ${mine ? "mine" : ""}">
            <img
              src="${esc(mine ? avatar(profile) : avatar(currentPerson))}"
              alt=""
            >

            <div class="message-content">
              <div class="message-author">
                ${mine ? "You" : esc(
                  currentPerson?.display_name ||
                  currentPerson?.username ||
                  "Member"
                )}
              </div>

              <div class="bubble">${body}</div>

              <div class="message-time">
                ${esc(fmtTime(message.created_at))}
              </div>
            </div>
          </article>
        `;
      })
    );

    if (currentPerson?.id !== activePerson?.id) return;

    box.innerHTML = rendered.join("");
    box.scrollTop = box.scrollHeight;
  }

  async function sendMessage(content = "", file = null) {
    if (!user || !activePerson || sending) return;

    content = String(content || "").trim();

    if (!content && !file) return;

    sending = true;

    $("#send-button").disabled = true;

    try {
      const attachment = {};

      if (file) {
        const maxBytes = cfg.maxFileBytes || 15 * 1024 * 1024;

        if (file.size > maxBytes) {
          throw new Error(
            `File is too large. Maximum size is ${fmtSize(maxBytes)}.`
          );
        }

        const safeName =
          file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120) ||
          "file";

        const path =
          `${user.id}/${crypto.randomUUID()}-${safeName}`;

        const { error: uploadError } = await db.storage
          .from("message-files")
          .upload(path, file, {
            contentType: file.type || "application/octet-stream",
            upsert: false
          });

        if (uploadError) throw uploadError;

        attachment.attachment_path = path;
        attachment.attachment_name = file.name;
        attachment.attachment_type =
          file.type || "application/octet-stream";
        attachment.attachment_size = file.size;
      }

      const row = {
        sender_id: user.id,
        receiver_id: activePerson.id,
        content,
        ...attachment
      };

      const { data, error } = await db
        .from("messages")
        .insert(row)
        .select(`
          id,
          sender_id,
          receiver_id,
          content,
          attachment_path,
          attachment_name,
          attachment_type,
          attachment_size,
          created_at
        `)
        .single();

      if (error) throw error;

      if (!messages.some(message => message.id === data.id)) {
        messages.push(data);
        await renderMessages();
      }

      $("#message-input").value = "";
      $("#file-input").value = "";
      $("#message-input").style.height = "auto";
    } catch (error) {
      console.error("Message send failed:", error);

      toast(`Message failed: ${error.message}`, true);
    } finally {
      sending = false;
      $("#send-button").disabled = !activePerson;
    }
  }

  // =========================================================
  // VOICE AND VIDEO CALLS
  // =========================================================

  // WebRTC uses Supabase Realtime Broadcast for signaling.
  // Some networks require a TURN server for reliable connections.

  function newCallId() {
    return crypto.randomUUID();
  }

  function userCallChannel() {
    return db.channel(`user-calls:${user.id}`, {
      config: {
        broadcast: { self: false }
      }
    });
  }

  function subscribeIncomingCalls() {
    if (incomingChannel) {
      db.removeChannel(incomingChannel);
    }

    incomingChannel = userCallChannel()
      .on(
        "broadcast",
        { event: "invite" },
        ({ payload }) => {
          if (!payload || payload.to !== user.id || currentCall) {
            return;
          }

          incomingCall = payload;

          const person = people.find(item => item.id === payload.from);

          if (person) {
            activePerson = person;
            renderPeople();
          }

          showIncoming(payload);
        }
      )
      .on(
        "broadcast",
        { event: "cancel" },
        ({ payload }) => {
          if (incomingCall?.callId === payload?.callId) {
            incomingCall = null;
            hideCallBanner();
          }
        }
      )
      .subscribe();
  }

  function showIncoming(call) {
    $("#call-banner").classList.remove("hidden");

    $("#call-status").textContent =
      `Incoming ${call.type === "video" ? "video" : "voice"} call`;

    $("#call-detail").textContent =
      `${call.fromName || "A member"} is calling you.`;

    $("#accept-call").classList.remove("hidden");
    $("#decline-call").classList.remove("hidden");
    $("#end-call").classList.add("hidden");

    $("#call-stage").classList.add("hidden");
  }

  function hideCallBanner() {
    $("#call-banner").classList.add("hidden");
  }

  async function inviteUser(to, event, payload) {
    const channel = db.channel(`user-calls:${to}`, {
      config: {
        broadcast: { self: false }
      }
    });

    try {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("Call signaling channel timed out."));
        }, 8000);

        channel.subscribe(status => {
          if (status === "SUBSCRIBED") {
            clearTimeout(timeout);
            resolve();
          }

          if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
            clearTimeout(timeout);
            reject(new Error("Unable to connect to call signaling."));
          }
        });
      });

      const { error } = await channel.send({
        type: "broadcast",
        event,
        payload
      });

      if (error) throw error;
    } finally {
      setTimeout(() => {
        db.removeChannel(channel);
      }, 1000);
    }
  }

  async function startCall(type) {
    if (!activePerson) {
      toast("Choose a person first.", true);
      return;
    }

    if (currentCall) {
      toast("A call is already active.", true);
      return;
    }

    try {
      currentCall = {
        callId: newCallId(),
        type,
        role: "caller",
        peerId: activePerson.id,
        peerName: activePerson.display_name || activePerson.username
      };

      await inviteUser(
        activePerson.id,
        "invite",
        {
          callId: currentCall.callId,
          type,
          from: user.id,
          to: activePerson.id,
          fromName: profile.display_name || profile.username
        }
      );

      $("#call-banner").classList.remove("hidden");

      $("#call-status").textContent = "Calling…";

      $("#call-detail").textContent =
        `Waiting for ${currentCall.peerName} to answer.`;

      $("#accept-call").classList.add("hidden");
      $("#decline-call").classList.add("hidden");
      $("#end-call").classList.remove("hidden");

      await setupCallChannel();
      await preparePeer(type);

      // Offer is sent after the other side accepts.
    } catch (error) {
      console.error("Could not start call:", error);

      toast(`Could not start call: ${error.message}`, true);

      await finishCall(false);
    }
  }

  async function acceptCall() {
    if (!incomingCall) return;

    const call = incomingCall;

    const person = people.find(item => item.id === call.from);

    if (person) {
      activePerson = person;
      renderPeople();
    }

    currentCall = {
      ...call,
      role: "callee",
      peerId: call.from,
      peerName: call.fromName || "Member"
    };

    incomingCall = null;

    hideCallBanner();

    try {
      await setupCallChannel();
      await preparePeer(call.type);

      $("#call-banner").classList.remove("hidden");

      $("#call-status").textContent = "Connecting call…";
      $("#call-detail").textContent = "Connecting audio/video…";

      $("#accept-call").classList.add("hidden");
      $("#decline-call").classList.add("hidden");
      $("#end-call").classList.remove("hidden");
    } catch (error) {
      toast(`Could not accept call: ${error.message}`, true);

      await finishCall(false);
    }
  }

  async function setupCallChannel() {
    if (callChannel) {
      await db.removeChannel(callChannel);
    }

    callChannel = db
      .channel(`call:${currentCall.callId}`, {
        config: {
          broadcast: { self: false }
        }
      })
      .on(
        "broadcast",
        { event: "signal" },
        async ({ payload }) => {
          if (
            !payload ||
            payload.from === user.id ||
            payload.callId !== currentCall?.callId ||
            !pc
          ) {
            return;
          }

          try {
            if (payload.description) {
              await pc.setRemoteDescription(payload.description);

              if (payload.description.type === "offer") {
                const answer = await pc.createAnswer();

                await pc.setLocalDescription(answer);

                await sendSignal({
                  description: pc.localDescription
                });
              }
            } else if (payload.candidate) {
              await pc.addIceCandidate(payload.candidate);
            }
          } catch (error) {
            console.error("WebRTC signaling error:", error);

            toast(`Call connection issue: ${error.message}`, true);
          }
        }
      )
      .on(
        "broadcast",
        { event: "accepted" },
        async ({ payload }) => {
          if (
            currentCall?.role !== "caller" ||
            payload?.callId !== currentCall.callId
          ) {
            return;
          }

          try {
            const offer = await pc.createOffer();

            await pc.setLocalDescription(offer);

            await sendSignal({
              description: pc.localDescription
            });
          } catch (error) {
            toast(`Could not create call offer: ${error.message}`, true);
          }
        }
      )
      .on(
        "broadcast",
        { event: "ended" },
        ({ payload }) => {
          if (payload?.callId === currentCall?.callId) {
            finishCall(false);
          }
        }
      )
      .subscribe(async status => {
        if (
          status === "SUBSCRIBED" &&
          currentCall?.role === "callee"
        ) {
          await sendSignal({ accepted: true });
        }
      });
  }

  async function sendSignal(extra) {
    if (!callChannel || !currentCall) return;

    const event = extra.accepted
      ? "accepted"
      : extra.ended
        ? "ended"
        : "signal";

    const { error } = await callChannel.send({
      type: "broadcast",
      event,
      payload: {
        ...extra,
        callId: currentCall.callId,
        from: user.id
      }
    });

    if (error) {
      console.error("Could not send call signal:", error);
    }
  }

  async function preparePeer(type) {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error(
        "Camera/microphone access requires HTTPS or localhost and a supported browser."
      );
    }

    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: type === "video"
    });

    remoteStream = new MediaStream();

    $("#local-video").srcObject = localStream;
    $("#remote-video").srcObject = remoteStream;

    $("#call-stage").classList.remove("hidden");

    pc = new RTCPeerConnection({
      iceServers: cfg.iceServers || [
        { urls: "stun:stun.l.google.com:19302" }
      ]
    });

    localStream.getTracks().forEach(track => {
      pc.addTrack(track, localStream);
    });

    pc.ontrack = event => {
      const streams = event.streams || [];

      if (streams[0]) {
        streams[0].getTracks().forEach(track => {
          if (
            !remoteStream.getTracks().some(
              existing => existing.id === track.id
            )
          ) {
            remoteStream.addTrack(track);
          }
        });
      }

      $("#remote-video").srcObject = remoteStream;
    };

    pc.onicecandidate = event => {
      if (event.candidate) {
        sendSignal({
          candidate: event.candidate.toJSON()
        });
      }
    };

    pc.onconnectionstatechange = () => {
      if (
        pc &&
        ["failed", "disconnected"].includes(pc.connectionState)
      ) {
        toast(
          "Call connection interrupted. A TURN server may be required.",
          true
        );
      }
    };

    callStartedAt = Date.now();

    clearInterval(callTimer);

    callTimer = setInterval(() => {
      if (!callStartedAt) return;

      const seconds = Math.floor(
        (Date.now() - callStartedAt) / 1000
      );

      const minutes = Math.floor(seconds / 60);
      const remainder = seconds % 60;

      $("#call-clock").textContent =
        `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
    }, 1000);

    $("#call-clock").textContent = "00:00";
  }

  async function declineCall() {
    if (incomingCall) {
      try {
        await inviteUser(
          incomingCall.from,
          "cancel",
          {
            callId: incomingCall.callId,
            from: user.id
          }
        );
      } catch (error) {
        console.error(error);
      }

      incomingCall = null;
    }

    hideCallBanner();
  }

  async function finishCall(notifyPeer = true) {
    const oldCall = currentCall;

    if (notifyPeer && oldCall) {
      try {
        await sendSignal({ ended: true });

        await inviteUser(
          oldCall.peerId,
          "cancel",
          {
            callId: oldCall.callId,
            from: user?.id
          }
        );
      } catch (error) {
        console.error("Could not notify other caller:", error);
      }
    }

    currentCall = null;
    incomingCall = null;

    clearInterval(callTimer);

    callTimer = null;
    callStartedAt = null;

    if (pc) {
      pc.ontrack = null;
      pc.onicecandidate = null;

      pc.close();
      pc = null;
    }

    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
    }

    if (remoteStream) {
      remoteStream.getTracks().forEach(track => track.stop());
    }

    localStream = null;
    remoteStream = null;

    $("#local-video").srcObject = null;
    $("#remote-video").srcObject = null;

    $("#call-stage").classList.add("hidden");

    $("#mute-call").textContent = "Mute mic";
    $("#camera-call").textContent = "Camera off";

    hideCallBanner();

    if (callChannel) {
      await db.removeChannel(callChannel);
      callChannel = null;
    }
  }

  function toggleMute() {
    if (!localStream) return;

    const track = localStream.getAudioTracks()[0];

    if (!track) return;

    track.enabled = !track.enabled;

    $("#mute-call").textContent =
      track.enabled ? "Mute mic" : "Unmute mic";
  }

  function toggleCamera() {
    if (!localStream) return;

    const track = localStream.getVideoTracks()[0];

    if (!track) {
      toast("This call does not have a camera track.", true);
      return;
    }

    track.enabled = !track.enabled;

    $("#camera-call").textContent =
      track.enabled ? "Camera off" : "Camera on";
  }

  // =========================================================
  // PASSWORD RESET LINK HANDLING
  // =========================================================

  async function handlePasswordRecovery() {
    const params = new URLSearchParams(location.search);

    if (!params.has("resetPassword")) return;

    const { data, error } = await db.auth.getSession();

    if (error) {
      authMessage(error.message, true);
      return;
    }

    if (!data.session) {
      authMessage(
        "Open the password reset link from your email again. If the link has expired, request another one.",
        true
      );

      return;
    }

    const password = prompt(
      "Enter your new password (at least 8 characters):"
    );

    if (password === null) return;

    try {
      await changePassword(password);

      history.replaceState(
        {},
        document.title,
        location.pathname
      );

      authMessage(
        "Password updated successfully. You can now log in with your new password."
      );

      await db.auth.signOut();
      showAuth();
    } catch (error) {
      authMessage(
        `Password update failed: ${error.message}`,
        true
      );
    }
  }

  // =========================================================
  // EVENT LISTENERS
  // =========================================================

  function wire() {
    $("#my-avatar").addEventListener("click", () => {
      $("#avatar-upload").click();
    });

    $("#my-avatar").addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        $("#avatar-upload").click();
      }
    });

    $("#avatar-upload").addEventListener("change", event => {
      const file = event.target.files?.[0];

      if (file) uploadAvatar(file);

      event.target.value = "";
    });

    document.querySelectorAll("[data-tab]").forEach(button => {
      button.addEventListener("click", () => {
        showTab(button.dataset.tab);
      });
    });

    $("#login-form").addEventListener("submit", event => {
      event.preventDefault();
      login(event.currentTarget);
    });

    $("#signup-form").addEventListener("submit", event => {
      event.preventDefault();
      signup(event.currentTarget);
    });

    $("#logout-button").addEventListener("click", logout);

    $("#refresh-users").addEventListener("click", loadPeople);

    $("#user-search").addEventListener("input", renderPeople);

    $("#people-list").addEventListener("click", event => {
      const button = event.target.closest("[data-person]");

      if (button) {
        openPerson(button.dataset.person);
      }
    });

    $("#message-form").addEventListener("submit", event => {
      event.preventDefault();

      const text = $("#message-input").value;
      const file = $("#file-input").files[0];

      sendMessage(text, file);
    });

    $("#file-input").addEventListener("change", () => {
      const file = $("#file-input").files[0];

      if (file) {
        toast(
          `Ready to share ${file.name} (${fmtSize(file.size)}). Press Send.`
        );
      }
    });

    $("#message-input").addEventListener("keydown", event => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        $("#message-form").requestSubmit();
      }

      if (activePerson && messageChannel) {
        clearTimeout(typingTimer);

        messageChannel.send({
          type: "broadcast",
          event: "typing",
          payload: { userId: user.id }
        });

        typingTimer = setTimeout(() => {}, 500);
      }
    });

    $("#message-input").addEventListener("input", event => {
      event.target.style.height = "auto";

      event.target.style.height =
        `${Math.min(event.target.scrollHeight, 130)}px`;
    });

    $("#voice-call").addEventListener("click", () => {
      startCall("audio");
    });

    $("#video-call").addEventListener("click", () => {
      startCall("video");
    });

    $("#accept-call").addEventListener("click", acceptCall);
    $("#decline-call").addEventListener("click", declineCall);

    $("#end-call").addEventListener("click", () => {
      finishCall(true);
    });

    $("#hangup-call").addEventListener("click", () => {
      finishCall(true);
    });

    $("#mute-call").addEventListener("click", toggleMute);
    $("#camera-call").addEventListener("click", toggleCamera);

    $("#theme-button").addEventListener("click", () => {
      const next =
        document.body.dataset.theme === "light"
          ? "dark"
          : "light";

      document.body.dataset.theme = next;

      localStorage.setItem("talkatch-theme", next);
    });

    // Add a password-reset control without requiring an HTML edit.
    const resetButton = document.createElement("button");

    resetButton.type = "button";
    resetButton.className = "text-btn";
    resetButton.textContent = "Forgot password?";
    resetButton.style.marginTop = "12px";
    resetButton.addEventListener("click", requestPasswordReset);

    $("#login-form").appendChild(resetButton);

    const savedTheme = localStorage.getItem("talkatch-theme");

    if (savedTheme === "light" || savedTheme === "dark") {
      document.body.dataset.theme = savedTheme;
    }
  }

  // =========================================================
  // INITIALIZATION
  // =========================================================

  async function init() {
    wire();

    if (
      !cfg.supabaseUrl ||
      !cfg.supabaseAnonKey ||
      cfg.supabaseAnonKey.includes("YOUR_SUPABASE")
    ) {
      authMessage(
        "Edit config.js and add your Supabase project URL and publishable/anon key.",
        true
      );

      return;
    }

    if (!window.supabase?.createClient) {
      authMessage(
        "Supabase library did not load. Check your internet connection.",
        true
      );

      return;
    }

    db = window.supabase.createClient(
      cfg.supabaseUrl,
      cfg.supabaseAnonKey
    );

    const { data, error } = await db.auth.getSession();

    if (error) {
      authMessage(error.message, true);
      return;
    }

    if (data.session?.user) {
      await startApp(data.session.user);
    } else {
      showAuth();
    }

    await handlePasswordRecovery();

    db.auth.onAuthStateChange((event, session) => {
      if (
        event === "SIGNED_IN" &&
        session?.user &&
        user?.id !== session.user.id
      ) {
        startApp(session.user);
      }

      if (event === "SIGNED_OUT") {
        user = null;
        profile = null;
        people = [];

        resetChatUI();
        showAuth();
      }

      if (event === "PASSWORD_RECOVERY") {
        handlePasswordRecovery();
      }
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
