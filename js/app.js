
(() => {
  "use strict";

  const config = window.TALKATCH_CONFIG || {};
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  let supabase;
  let currentUser = null;
  let currentProfile = null;
  let toastTimeout;

  function toast(message) {
    const el = $("#toast");
    el.textContent = message;
    el.classList.remove("hidden");
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => el.classList.add("hidden"), 3500);
  }

  function setAuthMessage(message, isError = false) {
    const el = $("#auth-message");
    el.textContent = message;
    el.classList.remove("hidden", "error");
    if (isError) el.classList.add("error");
  }

  function clearAuthMessage() {
    $("#auth-message").classList.add("hidden");
  }

  function setBusy(form, busy) {
    const button = $('button[type="submit"]', form);
    if (!button) return;
    button.disabled = busy;
    if (busy) {
      button.dataset.originalText = button.textContent;
      button.textContent = "Please wait…";
    } else if (button.dataset.originalText) {
      button.textContent = button.dataset.originalText;
      delete button.dataset.originalText;
      window.lucide?.createIcons();
    }
  }

  function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, ch => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[ch]);
  }

  function initials(name) {
    return String(name || "User").trim().split(/\s+/).slice(0, 2)
      .map(part => part[0] || "").join("").toUpperCase() || "U";
  }

  function avatarURL(profile) {
    return profile?.avatar_url ||
      `https://api.dicebear.com/9.x/initials/svg?seed=${encodeURIComponent(profile?.display_name || profile?.username || "User")}`;
  }

  function formatDate(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  }

  function showError(error, prefix = "Something went wrong") {
    console.error(prefix, error);
    const message = error?.message || String(error || "Unknown error");
    toast(`${prefix}: ${message}`);
  }

  function setTheme(mode) {
    const theme = mode === "light" ? "light" : "dark";
    document.body.dataset.theme = theme;
    try { localStorage.setItem("talkatch-theme", theme); } catch {}
    const button = $("#theme");
    if (button) {
      button.setAttribute("aria-label", theme === "dark" ? "Switch to light mode" : "Switch to dark mode");
      button.title = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
    }
    window.lucide?.createIcons();
  }

  function switchAuth(tab) {
    const signup = tab === "signup";
    $("#loginForm").classList.toggle("hidden", signup);
    $("#signupForm").classList.toggle("hidden", !signup);
    $$("[data-auth-tab]").forEach(button => {
      button.classList.toggle("active", button.dataset.authTab === tab);
    });
    clearAuthMessage();
  }

  function showApp(loggedIn) {
    $("#auth-view").classList.toggle("hidden", loggedIn);
    $("#app-view").classList.toggle("hidden", !loggedIn);
    $("#logout-btn").classList.toggle("hidden", !loggedIn);
    if (!loggedIn) $("#user-label").textContent = "Welcome";
  }

  async function getOrCreateProfile(user) {
    const { data, error } = await supabase
      .from("profiles")
      .select("id, username, display_name, bio, avatar_url")
      .eq("id", user.id)
      .maybeSingle();

    if (error) throw error;
    if (data) return data;

    const metadata = user.user_metadata || {};
    const base = String(metadata.username || user.email?.split("@")[0] || "member")
      .toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 18) || "member";
    const profile = {
      id: user.id,
      username: `${base}_${user.id.replace(/-/g, "").slice(0, 5)}`,
      display_name: metadata.display_name || base,
      bio: "",
      avatar_url: null
    };

    const result = await supabase.from("profiles").insert(profile)
      .select("id, username, display_name, bio, avatar_url").single();
    if (result.error) throw result.error;
    return result.data;
  }

  async function refreshProfile() {
    if (!currentUser) return;
    currentProfile = await getOrCreateProfile(currentUser);
    renderProfileSummary();
    fillProfileForm();
  }

  function renderProfileSummary() {
    if (!currentProfile) return;
    const name = currentProfile.display_name || currentProfile.username || "Member";
    $("#side-name").textContent = name;
    $("#side-username").textContent = `@${currentProfile.username || "member"}`;
    $("#side-avatar").src = avatarURL(currentProfile);
    $("#composer-avatar").src = avatarURL(currentProfile);
    $("#profile-avatar-preview").src = avatarURL(currentProfile);
    $("#user-label").textContent = name;
  }

  function fillProfileForm() {
    if (!currentProfile) return;
    $("#profile-display-name").value = currentProfile.display_name || "";
    $("#profile-username").value = currentProfile.username || "";
    $("#profile-bio").value = currentProfile.bio || "";
  }

  async function login(form) {
    clearAuthMessage();
    setBusy(form, true);
    try {
      const fd = new FormData(form);
      const { data, error } = await supabase.auth.signInWithPassword({
        email: String(fd.get("email") || "").trim(),
        password: String(fd.get("password") || "")
      });
      if (error) throw error;
      if (!data.user) throw new Error("Login did not return a user.");
      await enterApp(data.user);
    } catch (error) {
      setAuthMessage(error.message || "Unable to log in.", true);
    } finally {
      setBusy(form, false);
    }
  }

  async function signup(form) {
    clearAuthMessage();
    setBusy(form, true);
    try {
      const fd = new FormData(form);
      const displayName = String(fd.get("display_name") || "").trim();
      const username = String(fd.get("username") || "").trim().toLowerCase();
      const email = String(fd.get("email") || "").trim();
      const password = String(fd.get("password") || "");

      if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) {
        throw new Error("Username must be 3–24 characters using letters, numbers, or underscores.");
      }
      if (password.length < 8) throw new Error("Password must be at least 8 characters.");

      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: { display_name: displayName, username },
          emailRedirectTo: window.location.origin
        }
      });
      if (error) throw error;

      if (data.session && data.user) {
        await enterApp(data.user);
      } else {
        setAuthMessage("Account submitted. Check your email and click the confirmation link before logging in. Check your spam folder if you don't see it.");
        form.reset();
      }
    } catch (error) {
      setAuthMessage(error.message || "Unable to create your account.", true);
    } finally {
      setBusy(form, false);
    }
  }

  async function enterApp(user) {
    currentUser = user;
    try {
      await refreshProfile();
      showApp(true);
      await loadFeed();
      await loadNotifications();
      await loadPeople();
      await loadMyPosts();
      switchView("feed");
    } catch (error) {
      showApp(true);
      showError(error, "Unable to load your profile");
    }
  }

  async function logout() {
    const { error } = await supabase.auth.signOut();
    if (error) return showError(error, "Log out failed");
    currentUser = null;
    currentProfile = null;
    showApp(false);
    switchAuth("login");
    toast("You have logged out.");
  }

  async function forgotPassword() {
    const email = $("#login-email").value.trim();
    if (!email) {
      setAuthMessage("Enter your email address first, then choose forgot password.", true);
      return;
    }
    clearAuthMessage();
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: window.location.origin
      });
      if (error) throw error;
      setAuthMessage("If the email is registered, a password reset link will be sent. Check your inbox and spam folder.");
    } catch (error) {
      setAuthMessage(error.message || "Could not request a password reset.", true);
    }
  }

  async function createPost(form) {
    const fd = new FormData(form);
    const content = String(fd.get("content") || "").trim();
    if (!content) return;
    setBusy(form, true);
    try {
      const { error } = await supabase.from("posts").insert({
        user_id: currentUser.id,
        content
      });
      if (error) throw error;
      form.reset();
      await loadFeed();
      await loadMyPosts();
      toast("Your post was published.");
    } catch (error) {
      showError(error, "Could not publish post");
    } finally {
      setBusy(form, false);
    }
  }

  async function fetchProfiles(userIds) {
    const ids = [...new Set(userIds.filter(Boolean))];
    if (!ids.length) return {};
    const { data, error } = await supabase.from("profiles")
      .select("id, username, display_name, bio, avatar_url").in("id", ids);
    if (error) throw error;
    return Object.fromEntries((data || []).map(profile => [profile.id, profile]));
  }

  async function loadFeed() {
    const container = $("#feed-list");
    container.innerHTML = '<div class="panel empty-state">Loading posts…</div>';
    try {
      const { data: posts, error } = await supabase.from("posts")
        .select("id, user_id, content, created_at").order("created_at", { ascending: false }).limit(50);
      if (error) throw error;
      if (!posts?.length) {
        container.innerHTML = '<div class="panel empty-state">No posts yet. Be the first to share something!</div>';
        return;
      }

      const ids = posts.map(post => post.user_id);
      const profiles = await fetchProfiles(ids);
      const postIds = posts.map(post => post.id);

      const [likesResult, commentsResult, myLikesResult] = await Promise.all([
        supabase.from("likes").select("post_id, user_id").in("post_id", postIds),
        supabase.from("comments").select("id, post_id, user_id, content, created_at").in("post_id", postIds).order("created_at", { ascending: true }),
        supabase.from("likes").select("post_id").eq("user_id", currentUser.id).in("post_id", postIds)
      ]);
      if (likesResult.error) throw likesResult.error;
      if (commentsResult.error) throw commentsResult.error;
      if (myLikesResult.error) throw myLikesResult.error;

      const likes = likesResult.data || [];
      const comments = commentsResult.data || [];
      const likedIds = new Set((myLikesResult.data || []).map(row => row.post_id));
      const commentProfiles = await fetchProfiles(comments.map(comment => comment.user_id));

      container.innerHTML = posts.map(post => {
        const profile = profiles[post.user_id] || {};
        const postComments = comments.filter(comment => comment.post_id === post.id);
        const count = likes.filter(like => like.post_id === post.id).length;
        return `
          <article class="panel post-card" data-post-id="${escapeHTML(post.id)}">
            <div class="post-head">
              <img class="avatar" alt="" src="${escapeHTML(avatarURL(profile))}">
              <div class="post-author">
                <strong>${escapeHTML(profile.display_name || profile.username || "Member")}</strong>
                <div class="post-meta">@${escapeHTML(profile.username || "member")} · ${escapeHTML(formatDate(post.created_at))}</div>
              </div>
            </div>
            <div class="post-content">${escapeHTML(post.content)}</div>
            <div class="post-actions">
              <button class="action-btn ${likedIds.has(post.id) ? "liked" : ""}" data-action="like" type="button">
                <i data-lucide="heart"></i><span>${count}</span> Like
              </button>
              <button class="action-btn" data-action="focus-comment" type="button">
                <i data-lucide="message-circle"></i><span>${postComments.length}</span> Comment
              </button>
              ${post.user_id === currentUser.id ? '<button class="action-btn" data-action="delete-post" type="button"><i data-lucide="trash-2"></i> Delete</button>' : ""}
            </div>
            <div class="comment-list">${postComments.map(comment => {
              const author = commentProfiles[comment.user_id] || {};
              return `<div class="comment"><strong>${escapeHTML(author.display_name || author.username || "Member")}</strong>${escapeHTML(comment.content)}</div>`;
            }).join("")}</div>
            <form class="comment-form" data-post-id="${escapeHTML(post.id)}">
              <input name="content" maxlength="500" placeholder="Write a comment…" aria-label="Write a comment" required>
              <button type="submit" aria-label="Send comment"><i data-lucide="send"></i></button>
            </form>
          </article>`;
      }).join("");
      window.lucide?.createIcons();
    } catch (error) {
      container.innerHTML = '<div class="panel empty-state">Could not load posts. Check your Supabase tables and RLS policies.</div>';
      showError(error, "Feed error");
    }
  }

  async function toggleLike(postId, button) {
    try {
      const { data: existing, error: findError } = await supabase.from("likes")
        .select("post_id").eq("post_id", postId).eq("user_id", currentUser.id).maybeSingle();
      if (findError) throw findError;
      if (existing) {
        const { error } = await supabase.from("likes").delete()
          .eq("post_id", postId).eq("user_id", currentUser.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("likes").insert({
          post_id: postId, user_id: currentUser.id
        });
        if (error) throw error;
      }
      await loadFeed();
    } catch (error) {
      showError(error, "Could not update like");
    }
  }

  async function submitComment(form) {
    const postId = form.dataset.postId;
    const content = String(new FormData(form).get("content") || "").trim();
    if (!content) return;
    const button = $('button[type="submit"]', form);
    if (button) button.disabled = true;
    try {
      const { error } = await supabase.from("comments").insert({
        post_id: postId, user_id: currentUser.id, content
      });
      if (error) throw error;
      await loadFeed();
    } catch (error) {
      showError(error, "Could not add comment");
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function deletePost(postId) {
    if (!confirm("Delete this post? This cannot be undone.")) return;
    try {
      const { error } = await supabase.from("posts").delete()
        .eq("id", postId).eq("user_id", currentUser.id);
      if (error) throw error;
      await loadFeed();
      await loadMyPosts();
      toast("Post deleted.");
    } catch (error) {
      showError(error, "Could not delete post");
    }
  }

  async function saveProfile(form) {
    const fd = new FormData(form);
    const username = String(fd.get("username") || "").trim().toLowerCase();
    const displayName = String(fd.get("display_name") || "").trim();
    const bio = String(fd.get("bio") || "").trim();
    const file = $("#profile-avatar").files[0];
    if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) {
      return toast("Username must be 3–24 characters using letters, numbers, or underscores.");
    }
    setBusy(form, true);
    try {
      let avatar_url = currentProfile?.avatar_url || null;
      if (file) {
        if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
          throw new Error("Please upload a JPG, PNG, or WebP image.");
        }
        if (file.size > 3 * 1024 * 1024) throw new Error("Avatar must be 3 MB or smaller.");
        const extension = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
        const path = `${currentUser.id}/${Date.now()}.${extension}`;
        const { error: uploadError } = await supabase.storage.from("avatars").upload(path, file, {
          upsert: true, contentType: file.type
        });
        if (uploadError) throw uploadError;
        const { data: publicData } = supabase.storage.from("avatars").getPublicUrl(path);
        avatar_url = publicData.publicUrl;
      }

      const { data, error } = await supabase.from("profiles").upsert({
        id: currentUser.id, username, display_name: displayName, bio, avatar_url
      }, { onConflict: "id" }).select("id, username, display_name, bio, avatar_url").single();
      if (error) throw error;
      currentProfile = data;
      renderProfileSummary();
      fillProfileForm();
      $("#profile-avatar").value = "";
      await loadFeed();
      await loadMyPosts();
      toast("Profile saved.");
    } catch (error) {
      showError(error, "Could not save profile");
    } finally {
      setBusy(form, false);
    }
  }

  async function loadPeople() {
    const container = $("#people-list");
    container.innerHTML = '<div class="panel empty-state">Loading community…</div>';
    try {
      const { data, error } = await supabase.from("profiles")
        .select("id, username, display_name, bio, avatar_url")
        .neq("id", currentUser.id).order("username").limit(50);
      if (error) throw error;

      const { data: follows, error: followError } = await supabase.from("follows")
        .select("following_id").eq("follower_id", currentUser.id);
      if (followError) throw followError;
      const following = new Set((follows || []).map(row => row.following_id));

      if (!data?.length) {
        container.innerHTML = '<div class="panel empty-state">You’re one of the first here. Invite others to join TALKATCH!</div>';
        return;
      }

      container.innerHTML = data.map(person => `
        <article class="panel person-card" data-person-id="${escapeHTML(person.id)}">
          <img class="avatar" alt="" src="${escapeHTML(avatarURL(person))}">
          <h3>${escapeHTML(person.display_name || person.username || "Member")}</h3>
          <p class="muted">@${escapeHTML(person.username || "member")}</p>
          <p class="muted">${escapeHTML(person.bio || "A member of the TALKATCH community.")}</p>
          <button class="btn ${following.has(person.id) ? "btn-outline" : "btn-primary"} full" data-action="follow" type="button">
            ${following.has(person.id) ? "Following" : "Follow"}
          </button>
        </article>`).join("");
      window.lucide?.createIcons();
    } catch (error) {
      container.innerHTML = '<div class="panel empty-state">Could not load people. Check your profiles and follows table policies.</div>';
      showError(error, "Community error");
    }
  }

  async function toggleFollow(personId) {
    try {
      const { data: existing, error: findError } = await supabase.from("follows")
        .select("follower_id").eq("follower_id", currentUser.id)
        .eq("following_id", personId).maybeSingle();
      if (findError) throw findError;
      if (existing) {
        const { error } = await supabase.from("follows").delete()
          .eq("follower_id", currentUser.id).eq("following_id", personId);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("follows").insert({
          follower_id: currentUser.id, following_id: personId
        });
        if (error) throw error;
      }
      await loadPeople();
      toast(existing ? "You unfollowed this member." : "You are now following this member.");
    } catch (error) {
      showError(error, "Could not update follow");
    }
  }

 
async function loadNotifications() {
  const box = document.querySelector('#notifications');
  box.innerHTML = '<div class="panel">Loading notifications…</div>';

  const { data, error } = await db
    .from('notifications')
    .select('*')
    .eq('user_id', state.user.id)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) {
    console.error('TALKATCH notifications error:', error);
    box.innerHTML = `
      <div class="panel">
        Notifications could not load: ${
          esc(error.message)
        }
      </div>`;
    return;
  }

  if (!data || data.length === 0) {
    box.innerHTML = '<div class="panel">No notifications yet.</div>';
    return;
  }

  box.innerHTML = data.map(n => `
    <article class="post">
      <strong>${esc(n.message || n.type || 'Notification')}</strong>
      <p>${esc(
        n.created_at
          ? new Date(n.created_at).toLocaleString()
          : ''
      )}</p>
    </article>
  `).join('');
}


  async function markAllRead() {
    try {
      const { error } = await supabase.from("notifications").update({ is_read: true })
        .eq("user_id", currentUser.id).eq("is_read", false);
      if (error) throw error;
      await loadNotifications();
      toast("Notifications marked as read.");
    } catch (error) {
      showError(error, "Could not mark notifications read");
    }
  }

  async function loadMyPosts() {
    const container = $("#my-posts");
    try {
      const { data, error } = await supabase.from("posts")
        .select("id, content, created_at").eq("user_id", currentUser.id)
        .order("created_at", { ascending: false }).limit(30);
      if (error) throw error;
      container.innerHTML = data?.length ? data.map(post => `
        <article class="panel post-card">
          <div class="post-meta">${escapeHTML(formatDate(post.created_at))}</div>
          <div class="post-content">${escapeHTML(post.content)}</div>
          <button class="action-btn" data-action="delete-post" data-post-id="${escapeHTML(post.id)}" type="button">
            <i data-lucide="trash-2"></i> Delete
          </button>
        </article>`).join("") :
        '<div class="panel empty-state">You haven’t posted anything yet.</div>';
      window.lucide?.createIcons();
    } catch (error) {
      container.innerHTML = '<div class="panel empty-state">Could not load your posts.</div>';
      console.error(error);
    }
  }

  function switchView(view) {
    const valid = ["feed", "people", "notifications", "profile"].includes(view) ? view : "feed";
    $$(".content-view").forEach(section => section.classList.add("hidden"));
    $(`#${valid}-view`).classList.remove("hidden");
    $$(".nav-item").forEach(button => button.classList.toggle("active", button.dataset.view === valid));
    if (valid === "feed") loadFeed();
    if (valid === "people") loadPeople();
    if (valid === "notifications") loadNotifications();
    if (valid === "profile") { fillProfileForm(); loadMyPosts(); }
  }

  function bindEvents() {
    $$("[data-auth-tab]").forEach(button => button.addEventListener("click", () => switchAuth(button.dataset.authTab)));
    $("#theme").addEventListener("click", () => {
      setTheme(document.body.dataset.theme === "dark" ? "light" : "dark");
    });
    $("#logout-btn").addEventListener("click", logout);
    $("#forgot-password").addEventListener("click", forgotPassword);
    $("#refresh-feed").addEventListener("click", loadFeed);
    $("#mark-read").addEventListener("click", markAllRead);

    // Use the actual form from the submit event, never document as FormData's argument.
    document.addEventListener("submit", async event => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement)) return;

      if (["loginForm", "signupForm", "postForm", "profileForm"].includes(form.id) ||
          form.matches(".comment-form")) {
        event.preventDefault();
      } else return;

      if (!currentUser && !["loginForm", "signupForm"].includes(form.id)) return;

      if (form.id === "loginForm") await login(form);
      else if (form.id === "signupForm") await signup(form);
      else if (form.id === "postForm") await createPost(form);
      else if (form.id === "profileForm") await saveProfile(form);
      else if (form.matches(".comment-form")) await submitComment(form);
    });

    document.addEventListener("click", async event => {
      const viewButton = event.target.closest("[data-view]");
      if (viewButton) {
        switchView(viewButton.dataset.view);
        return;
      }

      const button = event.target.closest("[data-action]");
      if (!button || !currentUser) return;
      const action = button.dataset.action;

      if (action === "like") {
        const post = button.closest("[data-post-id]");
        if (post) await toggleLike(post.dataset.postId, button);
      } else if (action === "focus-comment") {
        const form = button.closest(".post-card")?.querySelector(".comment-form input");
        form?.focus();
      } else if (action === "delete-post") {
        const postId = button.dataset.postId || button.closest("[data-post-id]")?.dataset.postId;
        if (postId) await deletePost(postId);
      } else if (action === "follow") {
        const personId = button.closest("[data-person-id]")?.dataset.personId;
        if (personId) await toggleFollow(personId);
      }
    });

    $("#profile-avatar").addEventListener("change", () => {
      const file = $("#profile-avatar").files[0];
      if (file && file.size <= 3 * 1024 * 1024 && ["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
        $("#profile-avatar-preview").src = URL.createObjectURL(file);
      } else if (file) {
        toast("Choose a JPG, PNG, or WebP image under 3 MB.");
        $("#profile-avatar").value = "";
      }
    });
  }

  async function init() {
    $("#year").textContent = String(new Date().getFullYear());
    setTheme((() => { try { return localStorage.getItem("talkatch-theme") || "dark"; } catch { return "dark"; } })());
    window.lucide?.createIcons();
    bindEvents();

    if (!config.supabaseUrl || !config.supabasePublishableKey ||
        config.supabasePublishableKey.includes("PASTE_YOUR")) {
      showApp(false);
      setAuthMessage("Setup needed: add your Supabase publishable key to config.js.", true);
      return;
    }

    if (!window.supabase?.createClient) {
      setAuthMessage("Supabase could not load. Check your internet connection and refresh.", true);
      return;
    }

    supabase = window.supabase.createClient(config.supabaseUrl, config.supabasePublishableKey);

    const { data, error } = await supabase.auth.getSession();
    if (error) {
      setAuthMessage(error.message, true);
      return;
    }
    if (data.session?.user) await enterApp(data.session.user);
    else showApp(false);

    supabase.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT") {
        currentUser = null;
        currentProfile = null;
        showApp(false);
      } else if (event === "SIGNED_IN" && session?.user && session.user.id !== currentUser?.id) {
        // Defer DB work so it does not run inside the auth callback.
        setTimeout(() => enterApp(session.user), 0);
      } else if (event === "PASSWORD_RECOVERY") {
        toast("Password recovery opened. Use your configured recovery flow to set a new password.");
      }
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
