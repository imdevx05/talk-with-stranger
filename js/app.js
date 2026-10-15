```javascript
(() => {
  'use strict';

  // ==========================================
  // TALKATCH - Main application
  // ==========================================

  const cfg = window.TALKATCH_CONFIG;

  if (
    !cfg?.supabaseUrl ||
    !cfg?.supabasePublishableKey ||
    !window.supabase?.createClient
  ) {
    console.error(
      'TALKATCH: Check config.js and make sure Supabase JS v2 is loaded.'
    );
    return;
  }

  const db = window.supabase.createClient(
    cfg.supabaseUrl,
    cfg.supabasePublishableKey,
    {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true
      }
    }
  );

  const $ = (selector, root = document) =>
    root?.querySelector(selector) || null;

  const $$ = (selector, root = document) =>
    root ? [...root.querySelectorAll(selector)] : [];

  const state = {
    user: null,
    profile: null,
    view: 'feed',
    loadingProfile: false
  };

  const esc = value =>
    String(value ?? '').replace(/[&<>"']/g, char => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    })[char]);

  const initials = value =>
    String(value || 'T').trim().slice(0, 1).toUpperCase() || 'T';

  const val = (form, name) => {
    if (!form) return '';
    return String(new FormData(form).get(name) || '').trim();
  };

  function toast(message, isError = false) {
    const element = $('#toast');

    if (!element) {
      (isError ? console.error : console.log)(message);
      return;
    }

    element.textContent = String(message || '');
    element.classList.toggle('error', isError);
    element.style.display = 'block';

    clearTimeout(toast.timer);

    toast.timer = setTimeout(() => {
      if (element.isConnected) element.style.display = 'none';
    }, 5000);
  }

  function errorText(error) {
    const message = error?.message || 'Something went wrong.';

    if (/invalid login credentials/i.test(message)) {
      return 'Incorrect email or password.';
    }

    if (/email not confirmed/i.test(message)) {
      return 'Confirm your email before logging in.';
    }

    if (/already registered/i.test(message)) {
      return 'That email is already registered. Try logging in.';
    }

    if (/rate limit/i.test(message)) {
      return 'Too many attempts. Please wait and try again.';
    }

    if (/row-level security|permission denied/i.test(message)) {
      return 'Supabase denied this action. Check your table permissions and RLS policies.';
    }

    return message;
  }

  function setText(selector, value) {
    const element = $(selector);
    if (element) element.textContent = value ?? '';
  }

  function setValue(form, name, value) {
    const element = form?.elements?.namedItem(name);
    if (element) element.value = value ?? '';
  }

  function showAuth(tab = 'login') {
    const auth = $('#auth');
    const app = $('#app');
    const mobile = $('#mobile');

    if (auth) auth.hidden = false;
    if (app) app.hidden = true;
    if (mobile) mobile.hidden = true;

    $$('[data-tab]').forEach(button => {
      button.classList.toggle('active', button.dataset.tab === tab);
    });

    const loginForm = $('#loginForm');
    const signupForm = $('#signupForm');

    if (loginForm) loginForm.hidden = tab !== 'login';
    if (signupForm) signupForm.hidden = tab !== 'signup';
  }

  function avatar(image, fallback, url, name) {
    if (fallback) {
      fallback.hidden = !!url;
      fallback.textContent = initials(name);
    }

    if (!image) return;

    image.onerror = () => {
      image.hidden = true;
      if (fallback) fallback.hidden = false;
    };

    image.hidden = !url;

    if (url) {
      image.src = url;
    } else {
      image.removeAttribute('src');
    }
  }

  function theme(value) {
    document.body.dataset.theme = value;

    try {
      localStorage.setItem('talkatch-theme', value);
    } catch (error) {
      console.warn('Unable to save theme preference.', error);
    }
  }

  function accent(color) {
    document.documentElement.style.setProperty('--accent', color);

    try {
      localStorage.setItem('talkatch-accent', color);
    } catch (error) {
      console.warn('Unable to save accent preference.', error);
    }
  }

  function icons() {
    window.lucide?.createIcons();
  }

  function requireUser() {
    if (!state.user) {
      toast('Please log in first.', true);
      return false;
    }

    return true;
  }

  // ==========================================
  // PROFILE
  // ==========================================

  async function ensureProfile(user, preferredUsername = '') {
    if (!user?.id) {
      throw new Error('Your account session is missing. Please log in again.');
    }

    const existing = await db
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .maybeSingle();

    if (existing.error) throw existing.error;
    if (existing.data) return existing.data;

    const username =
      preferredUsername ||
      user.user_metadata?.username ||
      user.email?.split('@')[0] ||
      'member';

    const result = await db
      .from('profiles')
      .insert({
        id: user.id,
        username,
        display_name: user.user_metadata?.display_name || username,
        bio: '',
        avatar_url: null
      })
      .select()
      .single();

    if (!result.error) return result.data;

    // A profile might have been created by another request.
    const retry = await db
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .maybeSingle();

    if (!retry.error && retry.data) return retry.data;

    throw result.error;
  }

  async function loadProfile() {
    if (!requireUser()) return null;
    if (state.loadingProfile) return state.profile;

    state.loadingProfile = true;

    try {
      const result = await db
        .from('profiles')
        .select('*')
        .eq('id', state.user.id)
        .maybeSingle();

      if (result.error) throw result.error;

      state.profile =
        result.data || await ensureProfile(state.user);

      const profile = state.profile;
      const name =
        profile.display_name ||
        profile.username ||
        state.user.email ||
        'Member';

      // Update whichever profile elements exist in this HTML.
      setText('#sideName', name);
      setText('#sideHandle', '@' + (profile.username || 'user'));
      setText('#composeInitial', initials(name));

      avatar(
        $('#sidePhoto'),
        $('#sideInitial'),
        profile.avatar_url,
        name
      );

      avatar(
        $('#profilePhoto'),
        $('#profileInitial'),
        profile.avatar_url,
        name
      );

      const form = $('#profileForm');

      if (form) {
        setValue(form, 'username', profile.username || '');
        setValue(form, 'display_name', profile.display_name || '');
        setValue(form, 'bio', profile.bio || '');
      }

      return profile;
    } finally {
      state.loadingProfile = false;
    }
  }

  async function saveProfile(event) {
    event.preventDefault();

    if (!requireUser()) return;

    const form = event.currentTarget;

    if (!form) {
      toast('Profile form was not found in index.html.', true);
      return;
    }

    const username = val(form, 'username');

    if (!/^[A-Za-z0-9_]{3,24}$/.test(username)) {
      toast('Username must be 3–24 letters, numbers, or underscores.', true);
      return;
    }

    const result = await db
      .from('profiles')
      .update({
        username,
        display_name: val(form, 'display_name') || username,
        bio: val(form, 'bio')
      })
      .eq('id', state.user.id)
      .select()
      .single();

    if (result.error) {
      toast(errorText(result.error), true);
      return;
    }

    state.profile = result.data;

    try {
      await loadProfile();
    } catch (error) {
      console.error('Profile refresh failed:', error);
    }

    toast('Profile saved.');
  }

  async function uploadPhoto(event) {
    if (!requireUser()) return;

    const file = event.currentTarget?.files?.[0];
    if (!file) return;

    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      toast('Choose a JPG, PNG, or WebP image.', true);
      return;
    }

    if (file.size > 3 * 1024 * 1024) {
      toast('Image must be under 3 MB.', true);
      return;
    }

    const extension = {
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp'
    }[file.type];

    const path = `${state.user.id}/avatar-${Date.now()}.${extension}`;

    const upload = await db.storage
      .from('avatars')
      .upload(path, file, {
        upsert: true,
        contentType: file.type
      });

    if (upload.error) {
      console.error('Avatar upload failed:', upload.error);
      toast(
        'Photo upload failed. Check the avatars bucket and its Storage policies in Supabase.',
        true
      );
      return;
    }

    const publicUrl = db.storage
      .from('avatars')
      .getPublicUrl(path).data.publicUrl;

    const result = await db
      .from('profiles')
      .update({ avatar_url: publicUrl })
      .eq('id', state.user.id)
      .select()
      .single();

    if (result.error) {
      toast(errorText(result.error), true);
      return;
    }

    state.profile = result.data;

    try {
      await loadProfile();
    } catch (error) {
      console.error('Profile refresh failed:', error);
    }

    toast('Profile photo updated.');

    if (event.currentTarget) event.currentTarget.value = '';
  }

  // ==========================================
  // AUTHENTICATION
  // ==========================================

  async function signup(event) {
    event.preventDefault();

    const form = event.currentTarget;
    if (!form) return;

    const username = val(form, 'username');
    const email = val(form, 'email').toLowerCase();
    const password = val(form, 'password');

    if (!/^[A-Za-z0-9_]{3,24}$/.test(username)) {
      toast('Username must be 3–24 letters, numbers, or underscores.', true);
      return;
    }

    if (password.length < 8) {
      toast('Password must be at least 8 characters.', true);
      return;
    }

    const button = $('button[type="submit"]', form);
    if (button) button.disabled = true;

    try {
      const result = await db.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: location.origin + '/',
          data: {
            username,
            display_name: username
          }
        }
      });

      if (result.error) throw result.error;

      if (result.data.session) {
        await ensureProfile(result.data.user, username);
        await init(result.data.session);
        toast('Account created.');
      } else {
        toast(
          'Account submitted. Check your email and confirm your address before logging in.'
        );
      }
    } catch (error) {
      console.error('Signup failed:', error);
      toast(errorText(error), true);
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function login(event) {
    event.preventDefault();

    const form = event.currentTarget;
    if (!form) return;

    const button = $('button[type="submit"]', form);
    if (button) button.disabled = true;

    try {
      const result = await db.auth.signInWithPassword({
        email: val(form, 'email').toLowerCase(),
        password: val(form, 'password')
      });

      if (result.error) throw result.error;

      await init(result.data.session);
      toast('Welcome back.');
    } catch (error) {
      console.error('Login failed:', error);
      toast(errorText(error), true);
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function logout() {
    const result = await db.auth.signOut({ scope: 'local' });

    if (result.error) {
      toast(errorText(result.error), true);
      return;
    }

    state.user = null;
    state.profile = null;
    showAuth('login');
    toast('Logged out. Your account remains saved.');
  }

  async function resetPassword() {
    const email = prompt('Enter your account email:');
    if (!email) return;

    const result = await db.auth.resetPasswordForEmail(
      email.trim().toLowerCase(),
      { redirectTo: location.origin + '/' }
    );

    if (result.error) {
      toast(errorText(result.error), true);
      return;
    }

    toast('If the account exists, a password reset email has been requested.');
  }

  // ==========================================
  // FEED AND POSTS
  // ==========================================

  async function createPost(event) {
    event.preventDefault();

    if (!requireUser()) return;

    const form = event.currentTarget;
    const content = val(form, 'content');

    if (!content) return;

    const result = await db.from('posts').insert({
      user_id: state.user.id,
      content
    });

    if (result.error) {
      toast(errorText(result.error), true);
      return;
    }

    form.reset();
    await loadFeed();
    toast('Post published.');
  }

  async function loadFeed() {
    const box = $('#feed');

    // This was a common source of the null.innerHTML error.
    if (!box) {
      console.error('TALKATCH: Missing #feed element in index.html.');
      return;
    }

    if (!state.user) {
      box.textContent = 'Log in to view posts.';
      return;
    }

    box.innerHTML = '<div class="panel">Loading posts…</div>';

    try {
      const result = await db
        .from('posts')
        .select('id,user_id,content,created_at')
        .order('created_at', { ascending: false })
        .limit(50);

      if (result.error) throw result.error;

      const posts = result.data || [];

      if (!posts.length) {
        box.innerHTML =
          '<div class="panel">No posts yet. Share the first update.</div>';
        return;
      }

      const userIds = [...new Set(posts.map(post => post.user_id))];
      const postIds = posts.map(post => post.id);

      const [profileResult, likesResult] = await Promise.all([
        db.from('profiles')
          .select('id,username,display_name,avatar_url')
          .in('id', userIds),

        db.from('likes')
          .select('post_id,user_id')
          .in('post_id', postIds)
      ]);

      const profiles = Object.fromEntries(
        (profileResult.data || []).map(profile => [profile.id, profile])
      );

      const likes = likesResult.data || [];

      box.innerHTML = posts.map(post => {
        const profile = profiles[post.user_id] || {};
        const name = profile.display_name || profile.username || 'Member';

        const liked = likes.some(
          like =>
            like.post_id === post.id &&
            like.user_id === state.user.id
        );

        const count = likes.filter(
          like => like.post_id === post.id
        ).length;

        const photo = profile.avatar_url
          ? `<img src="${esc(profile.avatar_url)}" alt="">`
          : esc(initials(name));

        return `
          <article class="post" data-post="${esc(post.id)}">
            <header class="posthead">
              <div class="avatar">${photo}</div>
              <div>
                <strong>${esc(name)}</strong>
                <small>
                  @${esc(profile.username || 'member')}
                  · ${esc(post.created_at
                    ? new Date(post.created_at).toLocaleString()
                    : '')}
                </small>
              </div>
            </header>

            <p class="posttext">${esc(post.content)}</p>

            <div class="actions">
              <button
                type="button"
                data-action="like"
                data-id="${esc(post.id)}"
                data-liked="${liked}">
                <i data-lucide="heart"></i>
                ${liked ? 'Liked' : 'Like'} · ${count}
              </button>

              <button
                type="button"
                data-action="comments"
                data-id="${esc(post.id)}">
                <i data-lucide="message-circle"></i>
                Comment
              </button>
            </div>

            <div class="comments" hidden></div>
          </article>
        `;
      }).join('');

      icons();
    } catch (error) {
      console.error('Unable to load feed:', error);
      box.innerHTML =
        `<div class="panel">Unable to load posts: ${esc(errorText(error))}</div>`;
    }
  }

  async function like(postId, button) {
    if (!requireUser()) return;

    const alreadyLiked = button.dataset.liked === 'true';

    const result = alreadyLiked
      ? await db.from('likes')
          .delete()
          .eq('post_id', postId)
          .eq('user_id', state.user.id)
      : await db.from('likes').insert({
          post_id: postId,
          user_id: state.user.id
        });

    if (result.error) {
      toast(errorText(result.error), true);
      return;
    }

    await loadFeed();
  }

  // ==========================================
  // COMMENTS
  // ==========================================

  async function comments(postId, article) {
    const box = $('.comments', article);

    if (!box) {
      toast('The comments container is missing from this post.', true);
      return;
    }

    if (!box.hidden) {
      box.hidden = true;
      return;
    }

    box.hidden = false;
    box.innerHTML = '<p>Loading comments…</p>';

    try {
      const result = await db
        .from('comments')
        .select('id,user_id,content,created_at')
        .eq('post_id', postId)
        .order('created_at');

      if (result.error) throw result.error;

      const rows = result.data || [];
      const userIds = [...new Set(rows.map(comment => comment.user_id))];

      const profilesResult = userIds.length
        ? await db.from('profiles')
            .select('id,username,display_name')
            .in('id', userIds)
        : { data: [] };

      const profiles = Object.fromEntries(
        (profilesResult.data || []).map(profile => [profile.id, profile])
      );

      box.innerHTML =
        rows.map(comment => {
          const profile = profiles[comment.user_id] || {};

          return `
            <div class="comment">
              <strong>${esc(
                profile.display_name || profile.username || 'Member'
              )}</strong>
              ${esc(comment.content)}
            </div>
          `;
        }).join('') +
        `
          <form class="commentform" data-post="${esc(postId)}">
            <input
              name="content"
              maxlength="2000"
              placeholder="Write a comment…"
              required>
            <button type="submit" aria-label="Send">
              <i data-lucide="send"></i>
            </button>
          </form>
        `;

      icons();
    } catch (error) {
      console.error('Unable to load comments:', error);
      box.innerHTML =
        `<p>Comments unavailable: ${esc(errorText(error))}</p>`;
    }
  }

  async function submitComment(event) {
    event.preventDefault();

    if (!requireUser()) return;

    const form = event.currentTarget;
    const postId = form.dataset.post;
    const content = val(form, 'content');

    if (!content) return;

    const result = await db.from('comments').insert({
      post_id: postId,
      user_id: state.user.id,
      content
    });

    if (result.error) {
      toast(errorText(result.error), true);
      return;
    }

    const article = form.closest('.post');

    if (article) {
      const box = $('.comments', article);
      if (box) box.hidden = true;
      await comments(postId, article);
    }

    toast('Comment added.');
  }

  // ==========================================
  // DISCOVER AND FOLLOW
  // ==========================================

  async function loadPeople(term = '') {
    const box = $('#people');

    if (!box) {
      console.error('TALKATCH: Missing #people element in index.html.');
      return;
    }

    if (!state.user) {
      box.textContent = 'Log in to discover members.';
      return;
    }

    box.innerHTML = '<div class="panel">Loading people…</div>';

    try {
      let query = db
        .from('profiles')
        .select('id,username,display_name,bio,avatar_url')
        .order('username')
        .limit(100);

      if (term) {
        query = query.ilike('username', `%${term}%`);
      }

      const result = await query;

      if (result.error) throw result.error;

      const people = (result.data || []).filter(
        person => person.id !== state.user.id
      );

      if (!people.length) {
        box.innerHTML =
          '<div class="panel">No matching members found.</div>';
        return;
      }

      const followResult = await db
        .from('follows')
        .select('following_id')
        .eq('follower_id', state.user.id);

      // If the follows table is unavailable, still show members.
      if (followResult.error) {
        console.warn('Follow list unavailable:', followResult.error);
      }

      const following = new Set(
        (followResult.data || []).map(row => row.following_id)
      );

      box.innerHTML = people.map(person => {
        const name = person.display_name || person.username || 'Member';

        const photo = person.avatar_url
          ? `<img class="avatar" src="${esc(person.avatar_url)}" alt="">`
          : `<b class="avatar">${esc(initials(name))}</b>`;

        const isFollowing = following.has(person.id);

        return `
          <article class="person">
            ${photo}
            <h3>${esc(name)}</h3>
            <p>@${esc(person.username || 'member')}</p>
            <p>${esc(person.bio || 'A TALKATCH community member.')}</p>

            <button
              type="button"
              class="secondary"
              data-action="follow"
              data-user="${esc(person.id)}"
              data-following="${isFollowing}">
              ${isFollowing ? 'Following' : 'Follow'}
            </button>
          </article>
        `;
      }).join('');

      icons();
    } catch (error) {
      console.error('Unable to load members:', error);
      box.innerHTML =
        `<div class="panel">Unable to load profiles: ${esc(errorText(error))}</div>`;
    }
  }

  async function follow(userId, button) {
    if (!requireUser()) return;

    const alreadyFollowing = button.dataset.following === 'true';

    const result = alreadyFollowing
      ? await db.from('follows')
          .delete()
          .eq('follower_id', state.user.id)
          .eq('following_id', userId)
      : await db.from('follows').insert({
          follower_id: state.user.id,
          following_id: userId
        });

    if (result.error) {
      toast(errorText(result.error), true);
      return;
    }

    const search = $('#search');

    await loadPeople(search?.value.trim() || '');

    toast(alreadyFollowing
      ? 'Unfollowed member.'
      : 'Now following member.');
  }

  // ==========================================
  // NOTIFICATIONS
  // ==========================================

  async function loadNotifications() {
    const box = $('#notifications');

    if (!box) {
      console.error(
        'TALKATCH: Missing #notifications element in index.html.'
      );
      return;
    }

    if (!state.user) {
      box.textContent = 'Log in to view notifications.';
      return;
    }

    box.innerHTML = '<div class="panel">Loading notifications…</div>';

    try {
      // Select * so a missing optional "message" column does not
      // break notification loading.
      const result = await db
        .from('notifications')
        .select('*')
        .eq('user_id', state.user.id)
        .order('created_at', { ascending: false })
        .limit(50);

      if (result.error) throw result.error;

      const rows = result.data || [];

      if (!rows.length) {
        box.innerHTML =
          '<div class="panel">No notifications yet.</div>';
        return;
      }

      box.innerHTML = rows.map(notification => {
        const message =
          notification.message ||
          notification.type ||
          'You have a notification';

        const date = notification.created_at
          ? new Date(notification.created_at).toLocaleString()
          : '';

        return `
          <article class="post">
            <strong>${esc(message)}</strong>
            <p>${esc(date)}</p>
          </article>
        `;
      }).join('');
    } catch (error) {
      console.error('Unable to load notifications:', error);
      box.innerHTML =
        `<div class="panel">Notifications unavailable: ${esc(errorText(error))}</div>`;
    }
  }

  // ==========================================
  // NAVIGATION AND INITIALIZATION
  // ==========================================

  function setView(name) {
    state.view = name;

    $$('.view').forEach(view => {
      view.hidden = view.id !== name + 'View';
    });

    $$('[data-view]').forEach(button => {
      button.classList.toggle('selected', button.dataset.view === name);
    });

    // Catch errors independently so one missing section cannot
    // break navigation or the whole application.
    if (name === 'feed') {
      loadFeed().catch(error => {
        console.error('Feed error:', error);
      });
    }

    if (name === 'discover') {
      const search = $('#search');
      loadPeople(search?.value.trim() || '').catch(error => {
        console.error('Discover error:', error);
      });
    }

    if (name === 'notifications') {
      loadNotifications().catch(error => {
        console.error('Notifications error:', error);
      });
    }

    if (name === 'profile') {
      loadProfile().catch(error => {
        console.error('Profile error:', error);
        toast('Unable to load your profile: ' + errorText(error), true);
      });
    }
  }

  async function init(session) {
    state.user = session?.user || null;

    if (!state.user) {
      showAuth();
      return;
    }

    const auth = $('#auth');
    const app = $('#app');
    const mobile = $('#mobile');

    if (auth) auth.hidden = true;
    if (app) app.hidden = false;
    if (mobile) mobile.hidden = false;

    try {
      await loadProfile();
      setView(state.view);
    } catch (error) {
      console.error('Application initialization failed:', error);
      toast('Unable to load your profile: ' + errorText(error), true);
    }
  }

  // ==========================================
  // EVENT HANDLERS
  // ==========================================

  document.addEventListener('submit', event => {
    const target = event.target;

    if (target.id === 'loginForm') {
      login(event);
    } else if (target.id === 'signupForm') {
      signup(event);
    } else if (target.id === 'postForm') {
      createPost(event);
    } else if (target.id === 'profileForm') {
      saveProfile(event);
    } else if (target.matches('.commentform')) {
      submitComment(event);
    }
  });

  document.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button) return;

    if (button.dataset.tab) {
      showAuth(button.dataset.tab);
      return;
    }

    if (button.id === 'logout') {
      logout();
      return;
    }

    if (button.id === 'forgot') {
      resetPassword();
      return;
    }

    if (button.id === 'theme') {
      theme(
        document.body.dataset.theme === 'light' ? 'dark' : 'light'
      );
      return;
    }

    if (button.id === 'accent') {
      setView('settings');
      return;
    }

    if (button.id === 'refresh') {
      loadFeed();
      return;
    }

    if (button.dataset.theme) {
      theme(button.dataset.theme);
      return;
    }

    if (button.dataset.color) {
      accent(button.dataset.color);
      return;
    }

    if (button.dataset.view) {
      setView(button.dataset.view);
      return;
    }

    if (button.dataset.action === 'like') {
      like(button.dataset.id, button);
      return;
    }

    if (button.dataset.action === 'comments') {
      comments(button.dataset.id, button.closest('.post'));
      return;
    }

    if (button.dataset.action === 'follow') {
      follow(button.dataset.user, button);
    }
  });

  const avatarInput = $('#avatarFile');

  if (avatarInput) {
    avatarInput.addEventListener('change', uploadPhoto);
  }

  const searchInput = $('#search');

  if (searchInput) {
    searchInput.addEventListener('keydown', event => {
      if (event.key === 'Enter' && state.user) {
        event.preventDefault();
        setView('discover');
        loadPeople(searchInput.value.trim());
      }
    });
  }

  // ==========================================
  // START APPLICATION
  // ==========================================

  try {
    theme(localStorage.getItem('talkatch-theme') || 'dark');
    accent(localStorage.getItem('talkatch-accent') || '#a78bfa');
  } catch (error) {
    theme('dark');
    accent('#a78bfa');
  }

  icons();

  // Admin page placeholder. Real admin privileges must be
  // enforced by Supabase RLS or trusted server-side code.
  if (location.pathname.replace(/\/+$/, '') === '/admin') {
    document.body.innerHTML = `
      <main style="
        max-width:620px;
        margin:12vh auto;
        padding:24px;
        font:15px system-ui">
        <h1>TALKATCH Admin</h1>
        <p>
          Admin tools are not enabled. Configure authenticated admin
          permissions and enforce them with Supabase RLS or server-side
          functions before adding admin actions.
        </p>
        <a href="/">Return to TALKATCH</a>
      </main>
    `;
    return;
  }

  db.auth.getSession()
    .then(({ data, error }) => {
      if (error) {
        console.error('Unable to restore session:', error);
        showAuth();
        return;
      }

      return init(data.session);
    })
    .catch(error => {
      console.error('TALKATCH startup failed:', error);
      showAuth();
    });

  db.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT') {
      state.user = null;
      state.profile = null;
      showAuth();
    } else if (event === 'SIGNED_IN') {
      state.user = session?.user || null;
    }
  });

  // Public client-side helpers used by the app.
  window.TALKATCH = {
    db,
    logout,
    loadProfile,
    loadFeed,
    loadPeople,
    loadNotifications,
    setView
  };
})();
```
