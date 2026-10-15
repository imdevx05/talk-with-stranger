
(() => {
  "use strict";

  const $ = id => document.getElementById(id);
  const config = window.TALKATCH_CONFIG || {};

  let supabaseClient = null;
  let currentUser = null;
  let currentProfile = null;
  let authMode = "login";
  let currentPage = "feed";
  let toastTimer = null;

  const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);

  const initials = value => String(value || "T").trim().slice(0, 1).toUpperCase();

  function notify(message) {
    const toast = $("toast");
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 3200);
  }

  function setMessage(element, message, error = false) {
    element.textContent = message || "";
    element.classList.toggle("error", error);
  }

  function timeAgo(dateString) {
    const seconds = Math.max(0, (Date.now() - new Date(dateString).getTime()) / 1000);
    if (seconds < 60) return "just now";
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
    return new Date(dateString).toLocaleDateString();
  }

  function safeImageUrl(value) {
    try {
      const url = new URL(value);
      return ["https:", "http:"].includes(url.protocol) ? url.href : "";
    } catch {
      return "";
    }
  }

  function setAvatar(element, person) {
    const url = safeImageUrl(person?.avatar_url || "");
    element.textContent = initials(person?.display_name || person?.username);
    element.style.backgroundImage = url ? `url("${url.replace(/["\\]/g, "")}")` : "";
  }

  function showAuth() {
    $("authView").classList.remove("hidden");
    $("appView").classList.add("hidden");
  }

  function showApp() {
    $("authView").classList.add("hidden");
    $("appView").classList.remove("hidden");
  }

  function changeAuthMode(mode) {
    authMode = mode;
    document.querySelectorAll(".auth-tab").forEach(button => {
      button.classList.toggle("active", button.dataset.mode === mode);
    });

    $("usernameField").classList.toggle("hidden", mode !== "signup");
    $("authTitle").textContent = mode === "signup" ? "Create your account" : "Welcome back";
    $("authSubtitle").textContent = mode === "signup"
      ? "Join the community. We'll send you an email confirmation."
      : "Sign in to your TALKATCH account.";
    $("authSubmitText").textContent = mode === "signup" ? "Create account" : "Log in";
    $("forgotBtn").classList.toggle("hidden", mode === "signup");
    $("password").autocomplete = mode === "signup" ? "new-password" : "current-password";
    setMessage($("authMessage"), "");
  }

  async function getMyProfile() {
    const { data, error } = await supabaseClient
      .from("profiles")
      .select("id,username,display_name,bio,avatar_url,role,is_banned,created_at")
      .eq("id", currentUser.id)
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      throw new Error(
        "Your profile is missing. Confirm that schema.sql ran successfully and that the profile-creation trigger exists."
      );
    }

    if (data.is_banned) {
      await supabaseClient.auth.signOut();
      currentUser = null;
      currentProfile = null;
      showAuth();
      throw new Error("This account is currently disabled.");
    }

    currentProfile = data;
    setAvatar($("sidebarAvatar"), data);
    setAvatar($("composerAvatar"), data);
    setAvatar($("profileAvatar"), data);

    $("sidebarName").textContent = data.display_name || data.username;
    $("sidebarUsername").textContent = "@" + data.username;
    $("adminNav").classList.toggle("hidden", data.role !== "admin");

    $("displayName").value = data.display_name || "";
    $("profileUsername").value = data.username || "";
    $("bio").value = data.bio || "";
    $("avatarUrl").value = data.avatar_url || "";

    return data;
  }

  async function enterApplication(user) {
    currentUser = user;
    showApp();

    try {
      await getMyProfile();
      await navigate("feed");
    } catch (error) {
      if (currentUser) {
        showAuth();
        setMessage($("authMessage"), error.message, true);
      }
    }
  }

  function renderEmpty(title, description) {
    return `<div class="empty-state">
      <div class="empty-symbol">✦</div>
      <h3>${esc(title)}</h3>
      <p>${esc(description)}</p>
    </div>`;
  }

  async function loadFeed() {
    $("feedList").innerHTML = '<div class="loading">Loading your community…</div>';

    const { data: posts, error } = await supabaseClient
      .from("posts")
      .select("id,user_id,content,created_at,visibility")
      .eq("visibility", "public")
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) throw error;

    if (!posts?.length) {
      $("feedList").innerHTML = renderEmpty(
        "Your feed starts here",
        "Publish a thought to start the conversation."
      );
      return;
    }

    const postIds = posts.map(post => post.id);
    const userIds = [...new Set(posts.map(post => post.user_id))];

    const [profilesResult, likesResult, commentsResult] = await Promise.all([
      supabaseClient.from("profiles")
        .select("id,username,display_name,avatar_url")
        .in("id", userIds),
      supabaseClient.from("likes")
        .select("post_id,user_id")
        .in("post_id", postIds),
      supabaseClient.from("comments")
        .select("id,post_id,user_id,content,created_at")
        .in("post_id", postIds)
        .order("created_at", { ascending: true })
    ]);

    if (profilesResult.error) throw profilesResult.error;
    if (likesResult.error) throw likesResult.error;
    if (commentsResult.error) throw commentsResult.error;

    const profileMap = Object.fromEntries(
      (profilesResult.data || []).map(person => [person.id, person])
    );

    const likesByPost = {};
    (likesResult.data || []).forEach(like => {
      (likesByPost[like.post_id] ||= []).push(like);
    });

    const commentsByPost = {};
    (commentsResult.data || []).forEach(comment => {
      (commentsByPost[comment.post_id] ||= []).push(comment);
    });

    const commentUserIds = [...new Set((commentsResult.data || []).map(c => c.user_id))];
    let commentProfiles = {};

    if (commentUserIds.length) {
      const result = await supabaseClient.from("profiles")
        .select("id,username,display_name")
        .in("id", commentUserIds);

      if (result.error) throw result.error;

      commentProfiles = Object.fromEntries(
        (result.data || []).map(person => [person.id, person])
      );
    }

    $("feedList").innerHTML = posts.map(post => {
      const author = profileMap[post.user_id] || { username: "member", display_name: "Community member" };
      const postLikes = likesByPost[post.id] || [];
      const isLiked = postLikes.some(like => like.user_id === currentUser.id);
      const postComments = commentsByPost[post.id] || [];

      const commentsHTML = postComments.map(comment => {
        const person = commentProfiles[comment.user_id] || { username: "member", display_name: "Member" };
        return `<div class="comment"><strong>${esc(person.display_name || person.username)}</strong>${esc(comment.content)}</div>`;
      }).join("");

      return `<article class="post-card" data-post-card="${esc(post.id)}">
        <div class="post-header">
          <div class="avatar">${esc(initials(author.display_name || author.username))}</div>
          <div class="post-author">
            <strong>${esc(author.display_name || author.username)}</strong>
            <small>@${esc(author.username)} · ${esc(timeAgo(post.created_at))}</small>
          </div>
        </div>
        <div class="post-content">${esc(post.content)}</div>
        <div class="post-actions">
          <button type="button" data-like="${esc(post.id)}" class="${isLiked ? "liked" : ""}">
            ${isLiked ? "♥ Liked" : "♡ Like"} · ${postLikes.length}
          </button>
          <button type="button" data-comments="${esc(post.id)}">Comments · ${postComments.length}</button>
          ${post.user_id === currentUser.id
            ? `<button type="button" data-delete-post="${esc(post.id)}">Delete</button>`
            : ""}
        </div>
        <div class="comment-list" id="comments-${esc(post.id)}">${commentsHTML}</div>
        <form class="comment-form" data-comment-form="${esc(post.id)}">
          <input name="content" maxlength="1000" required placeholder="Write a comment…" aria-label="Write a comment">
          <button class="secondary" type="submit">Send</button>
        </form>
      </article>`;
    }).join("");
  }

  async function loadPeople() {
    $("peopleList").innerHTML = '<div class="loading">Finding people…</div>';

    const [peopleResult, followingResult] = await Promise.all([
      supabaseClient.from("profiles")
        .select("id,username,display_name,bio,avatar_url,created_at")
        .neq("id", currentUser.id)
        .order("created_at", { ascending: false })
        .limit(100),
      supabaseClient.from("follows")
        .select("following_id")
        .eq("follower_id", currentUser.id)
    ]);

    if (peopleResult.error) throw peopleResult.error;
    if (followingResult.error) throw followingResult.error;

    const following = new Set((followingResult.data || []).map(row => row.following_id));

    function drawPeople() {
      const query = $("peopleSearch").value.trim().toLowerCase();
      const filtered = (peopleResult.data || []).filter(person =>
        `${person.username} ${person.display_name || ""} ${person.bio || ""}`
          .toLowerCase().includes(query)
      );

      $("peopleList").innerHTML = filtered.length ? filtered.map(person => `
        <article class="person-card">
          <div class="avatar">${esc(initials(person.display_name || person.username))}</div>
          <div class="person-info">
            <strong>${esc(person.display_name || person.username)}</strong>
            <small>@${esc(person.username)}</small>
            <p>${esc(person.bio || "Part of the TALKATCH community.")}</p>
            <button type="button" class="secondary follow-button"
              data-follow="${esc(person.id)}"
              data-following="${following.has(person.id) ? "yes" : "no"}">
              ${following.has(person.id) ? "Following ✓" : "+ Follow"}
            </button>
          </div>
        </article>
      `).join("") : renderEmpty("No people found", "Try another search or come back when more people join.");
    }

    $("peopleList")._drawPeople = drawPeople;
    drawPeople();
  }

  async function loadNotifications() {
    $("notificationsList").innerHTML = '<div class="loading">Loading notifications…</div>';

    const { data, error } = await supabaseClient.from("notifications")
      .select("id,actor_id,type,post_id,conversation_id,is_read,created_at")
      .eq("recipient_id", currentUser.id)
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) throw error;

    if (!data?.length) {
      $("notificationsList").innerHTML = renderEmpty(
        "You're all caught up",
        "New notifications will appear here when your app creates them."
      );
      return;
    }

    const actorIds = [...new Set(data.map(item => item.actor_id).filter(Boolean))];
    let actors = {};

    if (actorIds.length) {
      const result = await supabaseClient.from("profiles")
        .select("id,username,display_name")
        .in("id", actorIds);
      if (result.error) throw result.error;
      actors = Object.fromEntries((result.data || []).map(p => [p.id, p]));
    }

    const labels = {
      like: "liked your post",
      comment: "commented on your post",
      follow: "started following you",
      message: "sent you a message"
    };

    $("notificationsList").innerHTML = data.map(item => {
      const actor = actors[item.actor_id] || { display_name: "Someone" };
      return `<article class="notification-card">
        <div class="avatar">${esc(initials(actor.display_name))}</div>
        <div>
          <strong>${esc(actor.display_name || actor.username || "Someone")}</strong>
          <p>${esc(labels[item.type] || "sent you a notification")} · ${esc(timeAgo(item.created_at))}</p>
          ${item.is_read ? '<small class="muted">Read</small>' : `<button class="secondary" type="button" data-read-notification="${esc(item.id)}">Mark read</button>`}
        </div>
      </article>`;
    }).join("");
  }

  async function loadAdmin() {
    if (currentProfile?.role !== "admin") {
      throw new Error("Your account does not have admin access.");
    }

    const [profiles, posts, reports] = await Promise.all([
      supabaseClient.from("profiles").select("id", { count: "exact", head: true }),
      supabaseClient.from("posts").select("id", { count: "exact", head: true }),
      supabaseClient.from("reports").select("id", { count: "exact", head: true }).eq("status", "open")
    ]);

    if (profiles.error) throw profiles.error;
    if (posts.error) throw posts.error;
    if (reports.error) throw reports.error;

    $("statUsers").textContent = profiles.count ?? 0;
    $("statPosts").textContent = posts.count ?? 0;
    $("statReports").textContent = reports.count ?? 0;
  }

  async function navigate(page) {
    if (page === "admin" && currentProfile?.role !== "admin") page = "feed";

    currentPage = page;
    document.querySelectorAll(".nav-item[data-page]").forEach(button => {
      button.classList.toggle("active", button.dataset.page === page);
    });
    document.querySelectorAll(".page").forEach(section => section.classList.add("hidden"));

    const section = $("page-" + page);
    if (!section) return;
    section.classList.remove("hidden");

    const titles = {
      feed: "Home feed",
      people: "Discover people",
      profile: "My profile",
      notifications: "Notifications",
      messages: "Messages",
      admin: "Admin panel"
    };
    $("pageTitle").textContent = titles[page] || "TALKATCH";

    try {
      if (page === "feed") await loadFeed();
      if (page === "people") await loadPeople();
      if (page === "notifications") await loadNotifications();
      if (page === "admin") await loadAdmin();
    } catch (error) {
      if (page === "feed") {
        $("feedList").innerHTML = renderEmpty("Couldn't load the feed", error.message);
      } else if (page === "people") {
        $("peopleList").innerHTML = renderEmpty("Couldn't load people", error.message);
      } else if (page === "notifications") {
        $("notificationsList").innerHTML = renderEmpty("Couldn't load notifications", error.message);
      } else {
        notify(error.message);
      }
    }
  }

  document.querySelectorAll(".auth-tab").forEach(button => {
    button.addEventListener("click", () => changeAuthMode(button.dataset.mode));
  });

  $("authForm").addEventListener("submit", async event => {
    event.preventDefault();
    const button = $("authSubmit");
    button.disabled = true;
    setMessage($("authMessage"), "");

    try {
      const email = $("email").value.trim();
      const password = $("password").value;

      if (authMode === "signup") {
        const username = $("username").value.trim().toLowerCase();
        if (!/^[a-z0-9_]{3,24}$/.test(username)) {
          throw new Error("Username must be 3–24 characters: lowercase letters, numbers, and underscores.");
        }

        const { data, error } = await supabaseClient.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: window.location.origin,
            data: { username }
          }
        });
        if (error) throw error;

        if (data.session?.user) {
          await enterApplication(data.session.user);
        } else {
          setMessage($("authMessage"),
            "Account submitted. Check your email and click the confirmation link before logging in. Check spam if you don't see it.");
        }
      } else {
        const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
        if (error) throw error;

        if (!data.user?.email_confirmed_at) {
          await supabaseClient.auth.signOut();
          throw new Error("Verify your email before logging in. Open the confirmation email first.");
        }
        await enterApplication(data.user);
      }
    } catch (error) {
      setMessage($("authMessage"), error.message || "Authentication failed.", true);
    } finally {
      button.disabled = false;
    }
  });

  $("forgotBtn").addEventListener("click", async () => {
    const email = $("email").value.trim();
    if (!email) {
      setMessage($("authMessage"), "Enter your email address first.", true);
      return;
    }

    try {
      const { error } = await supabaseClient.auth.resetPasswordForEmail(email, {
        redirectTo: window.location.origin
      });
      if (error) throw error;
      setMessage($("authMessage"), "If that account exists, a password reset email has been requested.");
    } catch (error) {
      setMessage($("authMessage"), error.message, true);
    }
  });

  $("postForm").addEventListener("submit", async event => {
    event.preventDefault();
    const content = $("postContent").value.trim();
    if (!content) return;

    const button = event.submitter;
    if (button) button.disabled = true;

    try {
      const { error } = await supabaseClient.from("posts").insert({
        user_id: currentUser.id,
        content,
        visibility: "public"
      });
      if (error) throw error;

      $("postContent").value = "";
      notify("Your post is live.");
      await loadFeed();
    } catch (error) {
      notify("Couldn't publish: " + error.message);
    } finally {
      if (button) button.disabled = false;
    }
  });

  $("feedList").addEventListener("click", async event => {
    const likeButton = event.target.closest("[data-like]");
    const deleteButton = event.target.closest("[data-delete-post]");
    const commentsButton = event.target.closest("[data-comments]");

    try {
      if (likeButton) {
        const postId = likeButton.dataset.like;
        const alreadyLiked = likeButton.classList.contains("liked");

        if (alreadyLiked) {
          const { error } = await supabaseClient.from("likes").delete()
            .eq("post_id", postId).eq("user_id", currentUser.id);
          if (error) throw error;
        } else {
          const { error } = await supabaseClient.from("likes").insert({
            post_id: postId, user_id: currentUser.id
          });
          if (error) throw error;
        }
        await loadFeed();
      }

      if (deleteButton) {
        if (!confirm("Delete your post permanently?")) return;
        const { error } = await supabaseClient.from("posts").delete()
          .eq("id", deleteButton.dataset.deletePost)
          .eq("user_id", currentUser.id);
        if (error) throw error;
        notify("Post deleted.");
        await loadFeed();
      }

      if (commentsButton) {
        const form = document.querySelector(`[data-comment-form="${CSS.escape(commentsButton.dataset.comments)}"]`);
        form?.querySelector("input")?.focus();
      }
    } catch (error) {
      notify(error.message);
    }
  });

  $("feedList").addEventListener("submit", async event => {
    const form = event.target.closest("[data-comment-form]");
    if (!form) return;
    event.preventDefault();

    const postId = form.dataset.commentForm;
    const input = form.querySelector('input[name="content"]');
    const content = input.value.trim();
    if (!content) return;

    const button = form.querySelector("button");
    button.disabled = true;

    try {
      const { error } = await supabaseClient.from("comments").insert({
        post_id: postId,
        user_id: currentUser.id,
        content
      });
      if (error) throw error;

      notify("Comment added.");
      await loadFeed();
    } catch (error) {
      notify("Couldn't add comment: " + error.message);
    } finally {
      button.disabled = false;
    }
  });

  $("peopleSearch").addEventListener("input", () => {
    $("peopleList")._drawPeople?.();
  });

  $("peopleList").addEventListener("click", async event => {
    const button = event.target.closest("[data-follow]");
    if (!button) return;

    const targetId = button.dataset.follow;
    const alreadyFollowing = button.dataset.following === "yes";
    button.disabled = true;

    try {
      if (alreadyFollowing) {
        const { error } = await supabaseClient.from("follows").delete()
          .eq("follower_id", currentUser.id).eq("following_id", targetId);
        if (error) throw error;
      } else {
        const { error } = await supabaseClient.from("follows").insert({
          follower_id: currentUser.id,
          following_id: targetId
        });
        if (error) throw error;
      }
      notify(alreadyFollowing ? "Unfollowed member." : "Now following member.");
      await loadPeople();
    } catch (error) {
      notify(error.message);
    } finally {
      button.disabled = false;
    }
  });

  $("profileForm").addEventListener("submit", async event => {
    event.preventDefault();

    const button = event.submitter;
    if (button) button.disabled = true;

    try {
      const username = $("profileUsername").value.trim().toLowerCase();
      if (!/^[a-z0-9_]{3,24}$/.test(username)) {
        throw new Error("Username must be 3–24 characters using lowercase letters, numbers, or underscores.");
      }

      const rawAvatar = $("avatarUrl").value.trim();
      const avatarUrl = rawAvatar ? safeImageUrl(rawAvatar) : null;
      if (rawAvatar && !avatarUrl) throw new Error("Enter a valid HTTP or HTTPS avatar URL.");

      const { data, error } = await supabaseClient.from("profiles")
        .update({
          username,
          display_name: $("displayName").value.trim(),
          bio: $("bio").value.trim(),
          avatar_url: avatarUrl
        })
        .eq("id", currentUser.id)
        .select("id,username,display_name,bio,avatar_url,role,is_banned,created_at")
        .single();

      if (error) throw error;
      currentProfile = data;
      await getMyProfile();
      setMessage($("profileMessage"), "Profile saved successfully.");
      notify("Profile updated.");
    } catch (error) {
      setMessage($("profileMessage"), error.message, true);
    } finally {
      if (button) button.disabled = false;
    }
  });

  $("notificationsList").addEventListener("click", async event => {
    const button = event.target.closest("[data-read-notification]");
    if (!button) return;

    try {
      const { error } = await supabaseClient.from("notifications")
        .update({ is_read: true })
        .eq("id", button.dataset.readNotification)
        .eq("recipient_id", currentUser.id);
      if (error) throw error;
      await loadNotifications();
    } catch (error) {
      notify(error.message);
    }
  });

  document.querySelectorAll(".nav-item[data-page]").forEach(button => {
    button.addEventListener("click", () => navigate(button.dataset.page));
  });

  $("refreshBtn").addEventListener("click", () => navigate(currentPage));

  $("logoutBtn").addEventListener("click", async () => {
    const { error } = await supabaseClient.auth.signOut();
    if (error) {
      notify(error.message);
      return;
    }

    currentUser = null;
    currentProfile = null;
    showAuth();
    changeAuthMode("login");
    notify("You have logged out.");
  });

  async function init() {
    if (!window.supabase?.createClient) {
      setMessage($("authMessage"), "Supabase library failed to load. Check your internet connection.", true);
      return;
    }

    if (!config.supabaseUrl || !config.supabasePublishableKey ||
        config.supabaseUrl.includes("YOUR_PROJECT") ||
        config.supabasePublishableKey.includes("YOUR_")) {
      setMessage($("authMessage"), "Add your Supabase URL and publishable key to config.js, then redeploy.", true);
      return;
    }

    try {
      supabaseClient = window.supabase.createClient(
        config.supabaseUrl,
        config.supabasePublishableKey
      );

      const { data, error } = await supabaseClient.auth.getSession();
      if (error) throw error;

      if (data.session?.user) {
        await enterApplication(data.session.user);
      } else {
        showAuth();
      }

      supabaseClient.auth.onAuthStateChange((event, session) => {
        if (event === "SIGNED_OUT") {
          currentUser = null;
          currentProfile = null;
          showAuth();
        } else if (session?.user && !currentUser) {
          setTimeout(() => enterApplication(session.user), 0);
        }
      });
    } catch (error) {
      setMessage($("authMessage"), error.message || "Could not initialize TALKATCH.", true);
    }
  }

  init();
})();
