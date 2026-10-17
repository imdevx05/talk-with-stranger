(() => {
  "use strict";

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  const config = window.TALKATCH_CONFIG || {};
  const authScreen = $("#auth-screen");
  const appScreen = $("#app-screen");
  const authForm = $("#auth-form");
  const authMessage = $("#auth-message");

  let supabase = null;
  let currentUser = null;
  let currentProfile = null;
  let authMode = "login";
  let activeConversation = null;
  let activeRecipient = null;
  let selectedPostImage = null;
  let selectedAvatar = null;
  let toastTimer = null;
  let feedRequest = 0;

  const escapeHTML = (value) =>
    String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[char]);

  const fallbackAvatar = (name) =>
    "https://api.dicebear.com/9.x/initials/svg?seed=" +
    encodeURIComponent(name || "User");

  function avatarFor(profile) {
    return profile?.avatar_url || fallbackAvatar(
      profile?.display_name || profile?.username || "User"
    );
  }

  function toast(message, error = false) {
    const el = $("#toast");
    if (!el) return;

    el.textContent = message;
    el.classList.toggle("error", error);
    el.classList.add("show");

    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 3500);
  }

  function setStatus(element, message, kind = "") {
    if (!element) return;
    element.textContent = message;
    element.classList.remove("error", "success");
    if (kind) element.classList.add(kind);
  }

  function renderIcons() {
    if (window.lucide) window.lucide.createIcons();
  }

  function setTheme(theme) {
    const light = theme === "light";
    document.documentElement.dataset.theme = light ? "light" : "dark";

    [$("#theme-toggle")].filter(Boolean).forEach((button) => {
      button.setAttribute("aria-checked", String(light));
    });

    localStorage.setItem("talkatch-theme", light ? "light" : "dark");
  }

  function toggleTheme() {
    setTheme(
      document.documentElement.dataset.theme === "light"
        ? "dark"
        : "light"
    );
  }

  function initializeTheme() {
    const saved = localStorage.getItem("talkatch-theme");
    setTheme(saved || "dark");

    $("#theme-toggle")?.addEventListener("click", toggleTheme);
    $("#mobile-theme-toggle")?.addEventListener("click", toggleTheme);
  }

  function setAuthMode(mode) {
    authMode = mode === "signup" ? "signup" : "login";

    $$(".auth-tab").forEach((button) => {
      button.classList.toggle("active", button.dataset.mode === authMode);
    });

    $("#auth-title").textContent =
      authMode === "signup" ? "Join the community" : "Welcome back";

    $("#auth-description").textContent =
      authMode === "signup"
        ? "Create your account and meet your people."
        : "Sign in to continue to TALKATCH.";

    $("#name-field").classList.toggle("hidden", authMode !== "signup");
    $("#username-field").classList.toggle("hidden", authMode !== "signup");

    const username = authForm.elements.username;
    const displayName = authForm.elements.display_name;

    username.required = authMode === "signup";
    displayName.required = authMode === "signup";

    authForm.elements.password.autocomplete =
      authMode === "signup" ? "new-password" : "current-password";

    $("#auth-submit").innerHTML =
      authMode === "signup"
        ? 'Create account <i data-lucide="arrow-right"></i>'
        : 'Continue <i data-lucide="arrow-right"></i>';

    setStatus(authMessage, "");
    renderIcons();
  }

  function showAuthenticatedApp() {
    authScreen.classList.add("hidden");
    appScreen.classList.remove("hidden");
  }

  function showAuthentication() {
    appScreen.classList.add("hidden");
    authScreen.classList.remove("hidden");
    setAuthMode("login");
  }

  async function ensureProfile(user) {
    const { data: existing, error } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", user.id)
      .maybeSingle();

    if (error) throw error;
    if (existing) return existing;

    const metadata = user.user_metadata || {};
    const base = String(
      metadata.username || user.email?.split("@")[0] || "member"
    ).toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 20) || "member";

    let username = base;

    const { data: taken } = await supabase
      .from("profiles")
      .select("username")
      .eq("username", username)
      .maybeSingle();

    if (taken) {
      username = `${base}_${user.id.slice(0, 6)}`;
    }

    const profile = {
      id: user.id,
      username,
      display_name: metadata.display_name || username,
      bio: "",
      avatar_url: null
    };

    const { data, error: insertError } = await supabase
      .from("profiles")
      .insert(profile)
      .select()
      .single();

    if (insertError) throw insertError;
    return data;
  }

  async function refreshProfile() {
    const { data, error } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", currentUser.id)
      .single();

    if (error) throw error;

    currentProfile = data;
    updateAccountUI();
    fillProfileForm();
    return data;
  }

  function updateAccountUI() {
    const avatar = avatarFor(currentProfile);
    const name = currentProfile?.display_name || "Community member";
    const username = currentProfile?.username || "member";

    $("#sidebar-avatar").src = avatar;
    $("#composer-avatar").src = avatar;
    $("#sidebar-name").textContent = name;
    $("#sidebar-username").textContent = "@" + username;
  }

  function fillProfileForm() {
    const form = $("#profile-form");
    if (!form || !currentProfile) return;

    form.elements.display_name.value = currentProfile.display_name || "";
    form.elements.username.value = currentProfile.username || "";
    form.elements.bio.value = currentProfile.bio || "";
    $("#profile-preview").src = avatarFor(currentProfile);
  }

  function friendlyError(error) {
    const message = error?.message || "Something went wrong.";

    if (/duplicate key|unique constraint/i.test(message)) {
      return "That username is already taken. Choose another one.";
    }

    if (/row-level security|permission denied/i.test(message)) {
      return "Supabase blocked this action. Check your table permissions and RLS policies.";
    }

    if (/invalid login credentials/i.test(message)) {
      return "Incorrect email or password.";
    }

    if (/email not confirmed/i.test(message)) {
      return "Confirm your email using the link sent to your inbox.";
    }

    return message;
  }

  async function handleAuthSubmit(event) {
    event.preventDefault();

    const form = event.currentTarget;
    const email = form.elements.email.value.trim();
    const password = form.elements.password.value;
    const submit = $("#auth-submit");

    submit.disabled = true;
    setStatus(authMessage, "Please wait…");

    try {
      if (authMode === "signup") {
        const username = form.elements.username.value.trim().toLowerCase();
        const displayName = form.elements.display_name.value.trim();

        if (!/^[a-z0-9_]{3,24}$/.test(username)) {
          throw new Error("Username must be 3–24 characters using letters, numbers, or underscores.");
        }

        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: {
              username,
              display_name: displayName
            },
            emailRedirectTo: window.location.origin
          }
        });

        if (error) throw error;

        if (data.session && data.user) {
          currentUser = data.user;
          currentProfile = await ensureProfile(currentUser);
          await enterApp();
        } else {
          setStatus(
            authMessage,
            "Account submitted. Check your email and click the confirmation link before logging in.",
            "success"
          );
        }
      } else {
        const { data, error } = await supabase.auth.signInWithPassword({
          email,
          password
        });

        if (error) throw error;

        currentUser = data.user;
        await enterApp();
      }
    } catch (error) {
      setStatus(authMessage, friendlyError(error), "error");
    } finally {
      submit.disabled = false;
    }
  }

  async function enterApp() {
    showAuthenticatedApp();

    try {
      currentProfile = await ensureProfile(currentUser);
      await refreshProfile();
    } catch (error) {
      toast("Unable to load profile: " + friendlyError(error), true);
    }

    await Promise.allSettled([
      loadFeed(),
      loadPeople(),
      loadNotifications(),
      loadMyPosts(),
      loadConversations()
    ]);

    switchView("feed");
  }

  async function logout() {
    const { error } = await supabase.auth.signOut();

    if (error) {
      toast(friendlyError(error), true);
      return;
    }

    currentUser = null;
    currentProfile = null;
    activeConversation = null;
    activeRecipient = null;

    showAuthentication();
  }

  function switchView(view) {
    const valid = ["feed", "explore", "notifications", "profile", "messages"];
    if (!valid.includes(view)) view = "feed";

    $$(".view").forEach((element) => element.classList.add("hidden"));
    $("#view-" + view)?.classList.remove("hidden");

    $$(".nav-item[data-view]").forEach((button) => {
      button.classList.toggle("active", button.dataset.view === view);
    });

    if (view === "feed") loadFeed();
    if (view === "explore") loadPeople();
    if (view === "notifications") loadNotifications();
    if (view === "profile") loadMyPosts();
    if (view === "messages") loadConversations();
  }

  function timeAgo(date) {
    const seconds = Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 1000));

    if (seconds < 60) return "Just now";
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;

    return new Date(date).toLocaleDateString();
  }

  async function uploadImage(file, folder) {
    if (!file) return null;

    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      throw new Error("Choose a JPG, PNG, or WebP image.");
    }

    if (file.size > 3 * 1024 * 1024) {
      throw new Error("Image must be 3 MB or smaller.");
    }

    const extension = file.type === "image/png"
      ? "png"
      : file.type === "image/webp" ? "webp" : "jpg";

    const path = `${currentUser.id}/${folder}-${crypto.randomUUID()}.${extension}`;

    const { error } = await supabase.storage
      .from("talkatch-media")
      .upload(path, file, { upsert: false, contentType: file.type });

    if (error) throw error;

    const { data } = supabase.storage
      .from("talkatch-media")
      .getPublicUrl(path);

    return data.publicUrl;
  }

  async function handlePostSubmit(event) {
    event.preventDefault();

    if (!currentUser) return;

    const form = event.currentTarget;
    const content = form.elements.content.value.trim();
    const submit = form.querySelector('button[type="submit"]');

    if (!content && !selectedPostImage) {
      toast("Write something or attach a photo.", true);
      return;
    }

    submit.disabled = true;

    try {
      let imageUrl = null;

      if (selectedPostImage) {
        imageUrl = await uploadImage(selectedPostImage, "post");
      }

      const { error } = await supabase.from("posts").insert({
        user_id: currentUser.id,
        content,
        image_url: imageUrl
      });

      if (error) throw error;

      form.reset();
      selectedPostImage = null;
      $("#post-image-preview").classList.add("hidden");
      $("#post-image-preview").replaceChildren();

      toast("Your post has been published.");
      await loadFeed();
      await loadMyPosts();
    } catch (error) {
      toast("Unable to publish: " + friendlyError(error), true);
    } finally {
      submit.disabled = false;
    }
  }

  async function loadFeed() {
    const container = $("#feed-list");
    if (!container || !currentUser) return;

    const request = ++feedRequest;
    container.innerHTML = '<div class="empty-state">Loading posts…</div>';

    try {
      const { data: posts, error } = await supabase
        .from("posts")
        .select("id,user_id,content,image_url,created_at")
        .order("created_at", { ascending: false })
        .limit(50);

      if (error) throw error;
      if (request !== feedRequest) return;

      if (!posts?.length) {
        container.innerHTML = '<div class="empty-state"><h3>Your feed starts here</h3><p>Be the first to share a moment.</p></div>';
        return;
      }

      const userIds = [...new Set(posts.map((post) => post.user_id))];
      const postIds = posts.map((post) => post.id);

      const [profilesResult, likesResult, commentsResult] = await Promise.all([
        supabase.from("profiles").select("id,username,display_name,avatar_url").in("id", userIds),
        supabase.from("likes").select("post_id,user_id").in("post_id", postIds),
        supabase.from("comments").select("id,post_id,user_id,content,created_at").in("post_id", postIds).order("created_at", { ascending: true })
      ]);

      if (request !== feedRequest) return;

      if (profilesResult.error) throw profilesResult.error;
      if (likesResult.error) throw likesResult.error;
      if (commentsResult.error) throw commentsResult.error;

      const profiles = Object.fromEntries((profilesResult.data || []).map((profile) => [profile.id, profile]));
      const likes = likesResult.data || [];
      const comments = commentsResult.data || [];

      const commentUserIds = [...new Set(comments.map((comment) => comment.user_id))];
      let commentProfiles = {};

      if (commentUserIds.length) {
        const { data, error: commentProfileError } = await supabase
          .from("profiles")
          .select("id,username,display_name,avatar_url")
          .in("id", commentUserIds);

        if (commentProfileError) throw commentProfileError;
        commentProfiles = Object.fromEntries((data || []).map((profile) => [profile.id, profile]));
      }

      container.innerHTML = posts.map((post) => {
        const profile = profiles[post.user_id] || {};
        const postLikes = likes.filter((like) => like.post_id === post.id);
        const liked = postLikes.some((like) => like.user_id === currentUser.id);
        const postComments = comments.filter((comment) => comment.post_id === post.id);

        return `
          <article class="post-card card" data-post-id="${escapeHTML(post.id)}">
            <header class="post-author">
              <img class="avatar" src="${escapeHTML(avatarFor(profile))}" alt="">
              <div class="post-author-info">
                <strong>${escapeHTML(profile.display_name || "Community member")}</strong>
                <small>@${escapeHTML(profile.username || "member")}</small>
              </div>
              <time class="post-time">${escapeHTML(timeAgo(post.created_at))}</time>
            </header>

            ${post.content ? `<div class="post-content">${escapeHTML(post.content)}</div>` : ""}
            ${post.image_url ? `<img class="post-image" src="${escapeHTML(post.image_url)}" alt="Post image" loading="lazy">` : ""}

            <div class="post-actions">
              <button class="post-action ${liked ? "liked" : ""}" data-action="like" data-id="${escapeHTML(post.id)}">
                <i data-lucide="${liked ? "heart" : "heart"}"></i> ${postLikes.length}
              </button>
              <button class="post-action" data-action="focus-comment" data-id="${escapeHTML(post.id)}">
                <i data-lucide="message-circle"></i> ${postComments.length} comments
              </button>
              ${post.user_id === currentUser.id ? `<button class="post-action" data-action="delete-post" data-id="${escapeHTML(post.id)}"><i data-lucide="trash-2"></i> Delete</button>` : ""}
            </div>

            <div class="comments">
              <div class="comment-list">
                ${postComments.map((comment) => {
                  const commenter = commentProfiles[comment.user_id] || {};
                  return `
                    <div class="comment">
                      <img class="avatar" src="${escapeHTML(avatarFor(commenter))}" alt="">
                      <div class="comment-bubble">
                        <strong>${escapeHTML(commenter.display_name || "Member")}</strong>
                        <span>${escapeHTML(comment.content)}</span>
                      </div>
                    </div>`;
                }).join("")}
              </div>

              <form class="comment-form" data-post-id="${escapeHTML(post.id)}">
                <input name="content" maxlength="1000" required placeholder="Write a comment…" aria-label="Write a comment">
                <button type="submit" aria-label="Submit comment"><i data-lucide="send"></i></button>
              </form>
            </div>
          </article>`;
      }).join("");

      renderIcons();
    } catch (error) {
      console.error("TALKATCH feed error:", error);
      container.innerHTML = `
        <div class="empty-state">
          <h3>Unable to load posts</h3>
          <p>${escapeHTML(friendlyError(error))}</p>
          <p>Confirm that the SQL setup has been run and the table columns match the app.</p>
        </div>`;
    }
  }

  async function handlePostAction(event) {
    const button = event.target.closest("[data-action]");
    if (!button) return;

    const id = button.dataset.id;
    const action = button.dataset.action;

    try {
      if (action === "like") {
        const { data: existing, error: lookupError } = await supabase
          .from("likes")
          .select("post_id")
          .eq("post_id", id)
          .eq("user_id", currentUser.id)
          .maybeSingle();

        if (lookupError) throw lookupError;

        if (existing) {
          const { error } = await supabase.from("likes")
            .delete().eq("post_id", id).eq("user_id", currentUser.id);
          if (error) throw error;
        } else {
          const { error } = await supabase.from("likes").insert({
            post_id: id,
            user_id: currentUser.id
          });
          if (error) throw error;
        }

        await loadFeed();
      }

      if (action === "focus-comment") {
        const input = document.querySelector(
          `.comment-form[data-post-id="${CSS.escape(id)}"] input`
        );
        input?.focus();
      }

      if (action === "delete-post") {
        if (!confirm("Delete this post?")) return;

        const { error } = await supabase.from("posts")
          .delete().eq("id", id).eq("user_id", currentUser.id);

        if (error) throw error;

        toast("Post deleted.");
        await loadFeed();
        await loadMyPosts();
      }
    } catch (error) {
      toast(friendlyError(error), true);
    }
  }

  async function handleCommentSubmit(event) {
    const form = event.target.closest(".comment-form");
    if (!form) return;

    event.preventDefault();

    const content = form.elements.content.value.trim();
    if (!content) return;

    try {
      const { error } = await supabase.from("comments").insert({
        post_id: form.dataset.postId,
        user_id: currentUser.id,
        content
      });

      if (error) throw error;

      await loadFeed();
      toast("Comment added.");
    } catch (error) {
      toast("Unable to comment: " + friendlyError(error), true);
    }
  }

  async function loadMyPosts() {
    const container = $("#my-posts");
    if (!container || !currentUser) return;

    container.innerHTML = '<div class="empty-state">Loading your posts…</div>';

    try {
      const { data, error } = await supabase.from("posts")
        .select("id,user_id,content,image_url,created_at")
        .eq("user_id", currentUser.id)
        .order("created_at", { ascending: false })
        .limit(50);

      if (error) throw error;

      if (!data?.length) {
        container.innerHTML = '<div class="empty-state">You have not published anything yet.</div>';
        return;
      }

      container.innerHTML = data.map((post) => `
        <article class="post-card card">
          <div class="post-author">
            <img class="avatar" src="${escapeHTML(avatarFor(currentProfile))}" alt="">
            <div class="post-author-info">
              <strong>${escapeHTML(currentProfile?.display_name || "You")}</strong>
              <small>@${escapeHTML(currentProfile?.username || "")}</small>
            </div>
            <time class="post-time">${escapeHTML(timeAgo(post.created_at))}</time>
          </div>
          ${post.content ? `<div class="post-content">${escapeHTML(post.content)}</div>` : ""}
          ${post.image_url ? `<img class="post-image" src="${escapeHTML(post.image_url)}" alt="Your post" loading="lazy">` : ""}
        </article>
      `).join("");
    } catch (error) {
      container.innerHTML = `<div class="empty-state">${escapeHTML(friendlyError(error))}</div>`;
    }

    renderIcons();
  }

  async function loadPeople() {
    const container = $("#people-list");
    if (!container || !currentUser) return;

    container.innerHTML = '<div class="empty-state">Discovering community members…</div>';

    try {
      const query = ($("#people-search")?.value || "").trim();

      let request = supabase.from("profiles")
        .select("id,username,display_name,bio,avatar_url,created_at")
        .neq("id", currentUser.id)
        .order("created_at", { ascending: false })
        .limit(100);

      if (query) {
        request = request.or(
          `username.ilike.%${query.replace(/[%_,()]/g, "")}%,display_name.ilike.%${query.replace(/[%_,()]/g, "")}%`
        );
      }

      const [{ data: people, error }, { data: following, error: followError }] = await Promise.all([
        request,
        supabase.from("follows").select("following_id").eq("follower_id", currentUser.id)
      ]);

      if (error) throw error;
      if (followError) throw followError;

      const followed = new Set((following || []).map((row) => row.following_id));

      if (!people?.length) {
        container.innerHTML = '<div class="empty-state">No other community members found yet. Invite a friend to join!</div>';
        renderSuggested([]);
        return;
      }

      container.innerHTML = people.map((person) => `
        <article class="person-card card">
          <img class="avatar" src="${escapeHTML(avatarFor(person))}" alt="">
          <h3>${escapeHTML(person.display_name || "Community member")}</h3>
          <p>@${escapeHTML(person.username || "member")}<br>${escapeHTML(person.bio || "A member of TALKATCH.")}</p>
          <button class="follow-button ${followed.has(person.id) ? "following" : ""}"
            data-follow="${escapeHTML(person.id)}"
            data-following="${followed.has(person.id)}">
            ${followed.has(person.id) ? "Following" : "Follow"}
          </button>
          <button class="post-action" data-message-user="${escapeHTML(person.id)}">
            <i data-lucide="message-circle"></i> Message
          </button>
        </article>
      `).join("");

      renderSuggested(people.slice(0, 5), followed);
      renderIcons();
    } catch (error) {
      console.error("People load error:", error);
      container.innerHTML = `<div class="empty-state">Unable to load users: ${escapeHTML(friendlyError(error))}</div>`;
    }
  }

  function renderSuggested(people, followed = new Set()) {
    const container = $("#suggested-list");
    if (!container) return;

    if (!people?.length) {
      container.innerHTML = '<p>No suggestions yet. Invite people to join.</p>';
      return;
    }

    container.innerHTML = people.slice(0, 5).map((person) => `
      <div class="suggested-user">
        <img class="avatar" src="${escapeHTML(avatarFor(person))}" alt="">
        <span class="suggested-info">
          <strong>${escapeHTML(person.display_name || "Community member")}</strong>
          <small>@${escapeHTML(person.username || "member")}</small>
        </span>
        <button class="follow-button ${followed.has(person.id) ? "following" : ""}"
          data-follow="${escapeHTML(person.id)}"
          data-following="${followed.has(person.id)}">
          ${followed.has(person.id) ? "Following" : "Follow"}
        </button>
      </div>
    `).join("");

    renderIcons();
  }

  async function handleFollowClick(event) {
    const button = event.target.closest("[data-follow]");
    if (!button) return;

    const targetId = button.dataset.follow;
    const alreadyFollowing = button.dataset.following === "true";

    try {
      if (alreadyFollowing) {
        const { error } = await supabase.from("follows")
          .delete().eq("follower_id", currentUser.id).eq("following_id", targetId);
        if (error) throw error;
        toast("You unfollowed this user.");
      } else {
        const { error } = await supabase.from("follows").insert({
          follower_id: currentUser.id,
          following_id: targetId
        });
        if (error) throw error;

        const { error: notificationError } = await supabase.from("notifications").insert({
          user_id: targetId,
          actor_id: currentUser.id,
          type: "follow",
          message: `${currentProfile?.display_name || "Someone"} started following you.`
        });

        if (notificationError) console.warn("Follow notification:", notificationError.message);
        toast("You are now following this user.");
      }

      await Promise.allSettled([loadPeople(), loadNotifications()]);
    } catch (error) {
      toast(friendlyError(error), true);
    }
  }

  async function handleProfileSave(event) {
    event.preventDefault();

    const form = event.currentTarget;
    const displayName = form.elements.display_name.value.trim();
    const username = form.elements.username.value.trim().toLowerCase();
    const bio = form.elements.bio.value.trim();

    if (!/^[a-z0-9_]{3,24}$/.test(username)) {
      setStatus($("#profile-message"), "Username must be 3–24 characters using letters, numbers, or underscores.", "error");
      return;
    }

    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;

    try {
      let avatarUrl = currentProfile?.avatar_url || null;

      if (selectedAvatar) {
        avatarUrl = await uploadImage(selectedAvatar, "avatar");
      }

      const { data, error } = await supabase.from("profiles")
        .update({
          display_name: displayName,
          username,
          bio,
          avatar_url: avatarUrl
        })
        .eq("id", currentUser.id)
        .select()
        .single();

      if (error) throw error;

      currentProfile = data;
      selectedAvatar = null;
      updateAccountUI();
      fillProfileForm();

      setStatus($("#profile-message"), "Profile saved successfully.", "success");
      toast("Profile updated.");
      await loadMyPosts();
    } catch (error) {
      setStatus($("#profile-message"), friendlyError(error), "error");
    } finally {
      submit.disabled = false;
    }
  }

  async function loadNotifications() {
    const container = $("#notifications-list");
    if (!container || !currentUser) return;

    container.innerHTML = '<div class="empty-state">Loading notifications…</div>';

    try {
      const { data, error } = await supabase.from("notifications")
        .select("*")
        .eq("user_id", currentUser.id)
        .order("created_at", { ascending: false })
        .limit(50);

      if (error) throw error;

      if (!data?.length) {
        container.innerHTML = '<div class="empty-state">You are all caught up.</div>';
        return;
      }

      container.innerHTML = data.map((notification) => `
        <article class="notification-item">
          <span class="notification-icon"><i data-lucide="${notification.type === "follow" ? "user-round-plus" : "bell"}"></i></span>
          <div>
            <p>${escapeHTML(notification.message || "You have a new notification.")}</p>
            <small>${escapeHTML(timeAgo(notification.created_at))}</small>
          </div>
        </article>
      `).join("");

      renderIcons();
    } catch (error) {
      console.error("Notifications error:", error);
      container.innerHTML = `<div class="empty-state">Unable to load notifications: ${escapeHTML(friendlyError(error))}</div>`;
    }
  }

  async function loadConversations() {
    const container = $("#conversation-list");
    if (!container || !currentUser) return;

    container.innerHTML = '<div class="empty-state">Loading…</div>';

    try {
      const { data: memberships, error } = await supabase
        .from("conversation_members")
        .select("conversation_id")
        .eq("user_id", currentUser.id);

      if (error) throw error;

      const ids = [...new Set((memberships || []).map((row) => row.conversation_id))];

      if (!ids.length) {
        container.innerHTML = '<div class="empty-state">No conversations yet.<p>Find someone in Explore people and select Message.</p></div>';
        return;
      }

      const { data: members, error: membersError } = await supabase
        .from("conversation_members")
        .select("conversation_id,user_id")
        .in("conversation_id", ids);

      if (membersError) throw membersError;

      const otherIds = [...new Set((members || [])
        .filter((row) => row.user_id !== currentUser.id)
        .map((row) => row.user_id))];

      const { data: people, error: peopleError } = await supabase
        .from("profiles")
        .select("id,username,display_name,avatar_url")
        .in("id", otherIds.length ? otherIds : [currentUser.id]);

      if (peopleError) throw peopleError;

      const profiles = Object.fromEntries((people || []).map((person) => [person.id, person]));
      const recipientByConversation = {};

      (members || []).forEach((member) => {
        if (member.user_id !== currentUser.id) {
          recipientByConversation[member.conversation_id] = profiles[member.user_id];
        }
      });

      container.innerHTML = ids.map((id) => {
        const recipient = recipientByConversation[id];
        if (!recipient) return "";

        return `
          <button class="conversation-item ${activeConversation === id ? "active" : ""}"
            data-conversation="${escapeHTML(id)}"
            data-recipient="${escapeHTML(recipient.id)}">
            <img class="avatar" src="${escapeHTML(avatarFor(recipient))}" alt="">
            <span><strong>${escapeHTML(recipient.display_name || "Member")}</strong><small>@${escapeHTML(recipient.username || "member")}</small></span>
          </button>`;
      }).join("") || '<div class="empty-state">No conversations yet.</div>';

      renderIcons();
    } catch (error) {
      console.error("Conversations error:", error);
      container.innerHTML = `<div class="empty-state">Unable to load conversations: ${escapeHTML(friendlyError(error))}</div>`;
    }
  }

  async function startConversation(recipientId) {
    if (!recipientId || recipientId === currentUser.id) return;

    try {
      const { data: memberships, error } = await supabase
        .from("conversation_members")
        .select("conversation_id")
        .eq("user_id", currentUser.id);

      if (error) throw error;

      for (const membership of memberships || []) {
        const { data: other, error: otherError } = await supabase
          .from("conversation_members")
          .select("user_id")
          .eq("conversation_id", membership.conversation_id)
          .eq("user_id", recipientId)
          .maybeSingle();

        if (otherError) throw otherError;

        if (other) {
          activeConversation = membership.conversation_id;
          activeRecipient = recipientId;
          await loadConversations();
          await openConversation(activeConversation, recipientId);
          return;
        }
      }

      const { data: conversation, error: conversationError } = await supabase
        .from("conversations")
        .insert({})
        .select()
        .single();

      if (conversationError) throw conversationError;

      const { error: membersError } = await supabase
        .from("conversation_members")
        .insert([
          { conversation_id: conversation.id, user_id: currentUser.id },
          { conversation_id: conversation.id, user_id: recipientId }
        ]);

      if (membersError) throw membersError;

      activeConversation = conversation.id;
      activeRecipient = recipientId;

      await loadConversations();
      await openConversation(activeConversation, recipientId);
    } catch (error) {
      toast("Unable to start conversation: " + friendlyError(error), true);
    }
  }

  async function openConversation(conversationId, recipientId) {
    activeConversation = conversationId;
    activeRecipient = recipientId;

    $("#chat-empty").classList.add("hidden");
    $("#chat-content").classList.remove("hidden");

    try {
      const { data: recipient, error: recipientError } = await supabase
        .from("profiles")
        .select("*")
        .eq("id", recipientId)
        .single();

      if (recipientError) throw recipientError;

      $("#chat-header").innerHTML = `
        <img class="avatar" src="${escapeHTML(avatarFor(recipient))}" alt="">
        <span>${escapeHTML(recipient.display_name || "Community member")}<br><small>@${escapeHTML(recipient.username || "member")}</small></span>
      `;

      const { data: messages, error } = await supabase
        .from("messages")
        .select("*")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: true })
        .limit(200);

      if (error) throw error;

      const container = $("#chat-messages");

      container.innerHTML = (messages || []).map((message) => `
        <div class="message-bubble ${message.sender_id === currentUser.id ? "mine" : ""}">
          ${escapeHTML(message.content)}
          <small>${escapeHTML(timeAgo(message.created_at))}</small>
        </div>
      `).join("") || '<div class="empty-state">Say hello to start the conversation.</div>';

      container.scrollTop = container.scrollHeight;
      renderIcons();
    } catch (error) {
      toast("Unable to open conversation: " + friendlyError(error), true);
    }
  }

  async function handleMessageSubmit(event) {
    event.preventDefault();

    if (!activeConversation) {
      setStatus($("#message-status"), "Choose or start a conversation first.", "error");
      return;
    }

    const form = event.currentTarget;
    const content = form.elements.content.value.trim();
    if (!content) return;

    try {
      const { error } = await supabase.from("messages").insert({
        conversation_id: activeConversation,
        sender_id: currentUser.id,
        content
      });

      if (error) throw error;

      form.reset();
      setStatus($("#message-status"), "");
      await openConversation(activeConversation, activeRecipient);
    } catch (error) {
      setStatus($("#message-status"), friendlyError(error), "error");
    }
  }

  function handleAvatarSelection(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      toast("Choose a JPG, PNG, or WebP image.", true);
      event.target.value = "";
      return;
    }

    if (file.size > 3 * 1024 * 1024) {
      toast("Image must be 3 MB or smaller.", true);
      event.target.value = "";
      return;
    }

    selectedAvatar = file;
    $("#profile-preview").src = URL.createObjectURL(file);
  }

  function handlePostImageSelection(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 3 * 1024 * 1024) {
      toast("Choose a JPG, PNG, or WebP image no larger than 3 MB.", true);
      event.target.value = "";
      return;
    }

    selectedPostImage = file;

    const preview = $("#post-image-preview");
    preview.innerHTML = `<img src="${URL.createObjectURL(file)}" alt="Selected post image">`;
    preview.classList.remove("hidden");
  }

  function registerEvents() {
    $$(".auth-tab").forEach((button) => {
      button.addEventListener("click", () => setAuthMode(button.dataset.mode));
    });

    authForm.addEventListener("submit", handleAuthSubmit);
    $("#logout-button").addEventListener("click", logout);
    $("#post-form").addEventListener("submit", handlePostSubmit);
    $("#profile-form").addEventListener("submit", handleProfileSave);
    $("#message-form").addEventListener("submit", handleMessageSubmit);

    $("#feed-list").addEventListener("click", handlePostAction);
    $("#feed-list").addEventListener("submit", handleCommentSubmit);

    $("#people-list").addEventListener("click", async (event) => {
      const messageButton = event.target.closest("[data-message-user]");
      if (messageButton) {
        switchView("messages");
        await startConversation(messageButton.dataset.messageUser);
        return;
      }

      await handleFollowClick(event);
    });

    $("#suggested-list").addEventListener("click", handleFollowClick);

    $("#conversation-list").addEventListener("click", (event) => {
      const button = event.target.closest("[data-conversation]");
      if (!button) return;

      openConversation(button.dataset.conversation, button.dataset.recipient);
    });

    $("#post-image").addEventListener("change", handlePostImageSelection);
    $("#profile-image").addEventListener("change", handleAvatarSelection);

    $("#refresh-feed").addEventListener("click", loadFeed);
    $("#refresh-people").addEventListener("click", loadPeople);
    $("#people-search").addEventListener("input", debounce(loadPeople, 250));

    $$("[data-view]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        switchView(button.dataset.view);
      });
    });
  }

  function debounce(callback, delay) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => callback(...args), delay);
    };
  }

  async function initialize() {
    initializeTheme();
    renderIcons();

    const url = config.supabaseUrl;
    const key = config.supabasePublishableKey;

    if (!url || !key || key.includes("PASTE_YOUR")) {
      setStatus(authMessage, "Set your Supabase URL and publishable key in config.js.", "error");
      return;
    }

    if (!window.supabase?.createClient) {
      setStatus(authMessage, "Supabase library did not load. Check your internet connection.", "error");
      return;
    }

    supabase = window.supabase.createClient(url, key);

    registerEvents();
    setAuthMode("login");

    const { data, error } = await supabase.auth.getSession();

    if (error) {
      console.error("Session error:", error);
      showAuthentication();
      return;
    }

    if (data.session?.user) {
      currentUser = data.session.user;
      await enterApp();
    } else {
      showAuthentication();
    }

    supabase.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT") {
        currentUser = null;
        currentProfile = null;
        showAuthentication();
      } else if (event === "SIGNED_IN" && session?.user && !currentUser) {
        currentUser = session.user;
        setTimeout(() => enterApp(), 0);
      }
    });
  }

  document.addEventListener("DOMContentLoaded", initialize);
})();
