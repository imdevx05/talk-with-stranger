(() => {
    "use strict";

    /* =====================================================
       1. CONFIGURATION AND HELPERS
    ===================================================== */

    const config = window.TALKATCH_CONFIG || {};

    const $ = (selector, root = document) =>
        root.querySelector(selector);

    const $$ = (selector, root = document) =>
        [...root.querySelectorAll(selector)];

    const escapeHTML = value =>
        String(value ?? "").replace(/[&<>"']/g, char => ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;"
        })[char]);

    const formatTime = value => {
        const date = new Date(value);

        if (Number.isNaN(date.getTime())) {
            return "";
        }

        return date.toLocaleString([], {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit"
        });
    };

    const formatSize = bytes => {
        if (bytes < 1024) {
            return `${bytes} B`;
        }

        if (bytes < 1024 * 1024) {
            return `${(bytes / 1024).toFixed(1)} KB`;
        }

        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    };

    const getAvatar = person => {
        if (person?.avatar_url) {
            return person.avatar_url;
        }

        const seed = encodeURIComponent(
            person?.display_name ||
            person?.username ||
            "Member"
        );

        return `https://api.dicebear.com/9.x/initials/svg?seed=${seed}`;
    };


    /* =====================================================
       2. APPLICATION STATE
    ===================================================== */

    let supabase = null;

    let currentUser = null;
    let currentProfile = null;

    let people = [];
    let activePerson = null;
    let messages = [];

    let messageChannel = null;
    let incomingChannel = null;
    let callChannel = null;

    let peerConnection = null;
    let localStream = null;
    let remoteStream = null;

    let currentCall = null;
    let incomingCall = null;

    let callStartedAt = null;
    let callTimer = null;

    let typingTimer = null;
    let typingOffTimer = null;

    let toastTimer = null;

    let sendingMessage = false;
    let startingApp = false;
    let loggingOut = false;


    /* =====================================================
       3. NOTIFICATIONS AND STATUS MESSAGES
    ===================================================== */

    function toast(message, isError = false) {
        const element = $("#toast");

        if (!element) {
            return;
        }

        element.textContent = message;

        element.classList.toggle("error", isError);
        element.classList.remove("hidden");

        clearTimeout(toastTimer);

        toastTimer = setTimeout(() => {
            element.classList.add("hidden");
        }, 4500);
    }


    function showAuthMessage(message, isError = false) {
        const element = $("#auth-message");

        element.textContent = message;

        element.classList.toggle("error", isError);
        element.classList.remove("hidden");
    }


    function setFormBusy(form, busy) {
        const button = $("button[type='submit']", form);

        if (!button) {
            return;
        }

        if (!button.dataset.originalText) {
            button.dataset.originalText = button.textContent;
        }

        button.disabled = busy;

        button.textContent = busy
            ? "Please wait…"
            : button.dataset.originalText;
    }


    /* =====================================================
       4. VIEW MANAGEMENT
    ===================================================== */

    function showAuth() {
        $("#auth-view").classList.remove("hidden");
        $("#app-view").classList.add("hidden");
    }


    function showApp() {
        $("#auth-view").classList.add("hidden");
        $("#app-view").classList.remove("hidden");
    }


    function showAuthTab(tab) {
        const signup = tab === "signup";

        $("#login-form").classList.toggle("hidden", signup);
        $("#signup-form").classList.toggle("hidden", !signup);

        $$("[data-tab]").forEach(button => {
            button.classList.toggle(
                "active",
                button.dataset.tab === tab
            );
        });

        $("#auth-title").textContent = signup
            ? "Create your account"
            : "Welcome back";

        $("#auth-message").classList.add("hidden");
    }


    /* =====================================================
       5. LOGIN
    ===================================================== */

    async function login(form) {
        setFormBusy(form, true);

        try {
            const formData = new FormData(form);

            const email = String(
                formData.get("email") || ""
            ).trim().toLowerCase();

            const password = String(
                formData.get("password") || ""
            );

            const { data, error } =
                await supabase.auth.signInWithPassword({
                    email,
                    password
                });

            if (error) {
                throw error;
            }

            if (!data.user) {
                throw new Error(
                    "Login did not return a user."
                );
            }

            await startApplication(data.user);

        } catch (error) {
            console.error("Login failed:", error);

            showAuthMessage(
                error.message || "Unable to log in.",
                true
            );

        } finally {
            setFormBusy(form, false);
        }
    }


    /* =====================================================
       6. REGISTRATION
    ===================================================== */

    async function signup(form) {
        setFormBusy(form, true);

        try {
            const formData = new FormData(form);

            const displayName = String(
                formData.get("display_name") || ""
            ).trim();

            const username = String(
                formData.get("username") || ""
            ).trim().toLowerCase();

            const email = String(
                formData.get("email") || ""
            ).trim().toLowerCase();

            const password = String(
                formData.get("password") || ""
            );

            if (!/^[a-z0-9_]{3,24}$/.test(username)) {
                throw new Error(
                    "Username must contain 3–24 letters, numbers, or underscores."
                );
            }

            if (password.length < 8) {
                throw new Error(
                    "Password must be at least 8 characters."
                );
            }

            const { data, error } =
                await supabase.auth.signUp({
                    email,
                    password,

                    options: {
                        data: {
                            username,
                            display_name:
                                displayName || username
                        },

                        emailRedirectTo: location.origin
                    }
                });

            if (error) {
                throw error;
            }

            if (data.session && data.user) {
                await startApplication(data.user);
            } else {
                form.reset();

                showAuthMessage(
                    "Your account has been submitted. Check your email and confirm your address before logging in."
                );
            }

        } catch (error) {
            console.error("Registration failed:", error);

            showAuthMessage(
                error.message || "Unable to create account.",
                true
            );

        } finally {
            setFormBusy(form, false);
        }
    }


    /* =====================================================
       7. PASSWORD RESET
    ===================================================== */

    async function resetPassword() {
        const emailInput = $(
            '#login-form input[name="email"]'
        );

        const email = emailInput.value.trim().toLowerCase();

        if (!email) {
            showAuthMessage(
                "Enter your email address in the login form first.",
                true
            );

            emailInput.focus();

            return;
        }

        const button = $("#forgot-password");

        button.disabled = true;

        try {
            const { error } =
                await supabase.auth.resetPasswordForEmail(
                    email,
                    {
                        redirectTo: location.origin
                    }
                );

            if (error) {
                throw error;
            }

            showAuthMessage(
                "If password recovery is configured, check your email for the reset link."
            );

        } catch (error) {
            showAuthMessage(
                error.message || "Unable to request a password reset.",
                true
            );

        } finally {
            button.disabled = false;
        }
    }


    /* =====================================================
       8. PROFILE LOADING
    ===================================================== */

    async function getProfile(authUser) {
        const { data, error } = await supabase
            .from("profiles")
            .select(
                "id, username, display_name, bio, avatar_url"
            )
            .eq("id", authUser.id)
            .maybeSingle();

        if (error) {
            throw error;
        }

        if (data) {
            return data;
        }

        /*
         * If no profile exists, try creating one.
         *
         * Your Supabase database must permit the signed-in
         * user to insert their own profile, or have a
         * suitable profile-creation trigger.
         */

        const metadata = authUser.user_metadata || {};

        const baseUsername = String(
            metadata.username ||
            authUser.email?.split("@")[0] ||
            "member"
        )
            .toLowerCase()
            .replace(/[^a-z0-9_]/g, "")
            .slice(0, 18) || "member";

        const profileRow = {
            id: authUser.id,

            username:
                `${baseUsername}_${authUser.id
                    .replace(/-/g, "")
                    .slice(0, 5)}`,

            display_name:
                metadata.display_name || baseUsername,

            bio: "",
            avatar_url: null
        };

        const result = await supabase
            .from("profiles")
            .upsert(profileRow, {
                onConflict: "id"
            })
            .select(
                "id, username, display_name, bio, avatar_url"
            )
            .single();

        if (result.error) {
            throw result.error;
        }

        return result.data;
    }


    /* =====================================================
       9. START APPLICATION
    ===================================================== */

    async function startApplication(authUser) {
        if (startingApp) {
            return;
        }

        startingApp = true;

        try {
            currentUser = authUser;

            currentProfile = await getProfile(authUser);

            showApp();

            renderCurrentProfile();

            await loadPeople();

            subscribeIncomingCalls();

        } catch (error) {
            console.error(
                "Unable to initialize the application:",
                error
            );

            showAuthMessage(
                "Unable to load your profile: " +
                (error.message || "Unknown error"),
                true
            );

            showAuth();

        } finally {
            startingApp = false;
        }
    }


    function renderCurrentProfile() {
        if (!currentProfile) {
            return;
        }

        $("#my-avatar").src = getAvatar(currentProfile);

        $("#my-name").textContent =
            currentProfile.display_name ||
            currentProfile.username ||
            "Member";

        $("#my-handle").textContent =
            "@" + (
                currentProfile.username || "member"
            );
    }


    /* =====================================================
       10. PROFILE PICTURE UPLOAD
    ===================================================== */

    async function uploadAvatar(file) {
        if (!currentUser || !currentProfile || !file) {
            return;
        }

        const supportedTypes = [
            "image/jpeg",
            "image/png",
            "image/webp"
        ];

        if (!supportedTypes.includes(file.type)) {
            toast(
                "Choose a JPG, PNG, or WebP image.",
                true
            );

            return;
        }

        if (file.size > 3 * 1024 * 1024) {
            toast(
                "Your profile picture must be 3 MB or smaller.",
                true
            );

            return;
        }

        try {
            const extension = {
                "image/jpeg": "jpg",
                "image/png": "png",
                "image/webp": "webp"
            }[file.type];

            const path =
                `${currentUser.id}/${crypto.randomUUID()}.${extension}`;

            const { data, error } = await supabase
                .storage
                .from("avatars")
                .upload(path, file, {
                    contentType: file.type,
                    upsert: false,
                    cacheControl: "3600"
                });

            if (error) {
                throw error;
            }

            const publicURL = supabase
                .storage
                .from("avatars")
                .getPublicUrl(data.path)
                .data.publicUrl;

            const result = await supabase
                .from("profiles")
                .update({
                    avatar_url: publicURL
                })
                .eq("id", currentUser.id)
                .select(
                    "id, username, display_name, bio, avatar_url"
                )
                .single();

            if (result.error) {
                throw result.error;
            }

            currentProfile = result.data;

            renderCurrentProfile();

            renderPeople();

            if (activePerson?.id === currentProfile.id) {
                $("#chat-avatar").src = publicURL;
            }

            toast("Profile picture updated.");

        } catch (error) {
            console.error("Avatar upload failed:", error);

            toast(
                "Avatar upload failed: " +
                (error.message || "Unknown error") +
                ". Check the avatars bucket and its storage policies.",
                true
            );
        }
    }


    /* =====================================================
       11. LOAD MEMBERS
    ===================================================== */

    async function loadPeople() {
        if (!currentUser) {
            return;
        }

        $("#people-list").innerHTML =
            '<div class="empty-small">Loading people…</div>';

        const { data, error } = await supabase
            .from("profiles")
            .select(
                "id, username, display_name, bio, avatar_url"
            )
            .neq("id", currentUser.id)
            .order("display_name", {
                ascending: true
            })
            .limit(300);

        if (error) {
            console.error("Unable to load members:", error);

            $("#people-list").innerHTML =
                '<div class="empty-small">' +
                'Could not load members. Check your profiles table and RLS policies.' +
                '</div>';

            return;
        }

        people = data || [];

        renderPeople();
    }


    /* =====================================================
       12. RENDER MEMBER LIST
    ===================================================== */

    function renderPeople() {
        const list = $("#people-list");

        if (!list) {
            return;
        }

        const term = $("#user-search").value
            .trim()
            .toLowerCase();

        const filtered = people.filter(person => {
            const searchable = [
                person.display_name || "",
                person.username || ""
            ].join(" ").toLowerCase();

            return searchable.includes(term);
        });

        if (!filtered.length) {
            list.innerHTML =
                '<div class="empty-small">' +
                'No members found. Ask someone to create an account.' +
                '</div>';

            return;
        }

        list.innerHTML = filtered.map(person => {
            const selected =
                activePerson?.id === person.id;

            return `
                <button
                    class="person ${selected ? "active" : ""}"
                    data-person="${escapeHTML(person.id)}"
                    type="button"
                >
                    <img
                        src="${escapeHTML(getAvatar(person))}"
                        alt=""
                    >

                    <span class="person-meta">
                        <strong>
                            ${escapeHTML(
                                person.display_name ||
                                person.username ||
                                "Member"
                            )}
                        </strong>

                        <small>
                            @${escapeHTML(
                                person.username || "member"
                            )}
                        </small>
                    </span>

                    <span
                        class="person-status"
                        title="Member"
                    ></span>
                </button>
            `;
        }).join("");
    }


    /* =====================================================
       13. OPEN A CONVERSATION
    ===================================================== */

    async function openPerson(personId) {
        const person = people.find(
            item => item.id === personId
        );

        if (!person) {
            return;
        }

        if (activePerson?.id === person.id) {
            return;
        }

        activePerson = person;

        messages = [];

        renderPeople();

        $("#chat-title").textContent =
            person.display_name ||
            person.username ||
            "Member";

        $("#chat-subtitle").textContent =
            "@" + (person.username || "member");

        $("#chat-avatar").src = getAvatar(person);

        $("#voice-call").disabled = false;
        $("#video-call").disabled = false;

        $("#message-input").disabled = false;
        $("#send-button").disabled = false;
        $("#file-input").disabled = false;

        $("#message-input").placeholder =
            `Message ${person.display_name || person.username || "member"}…`;

        $("#typing-indicator").classList.add("hidden");

        if (messageChannel) {
            await supabase.removeChannel(messageChannel);
            messageChannel = null;
        }

        await loadMessages();

        if (activePerson?.id === person.id) {
            subscribeMessages();
        }
    }


    /* =====================================================
       14. LOAD DIRECT MESSAGES
    ===================================================== */

    async function loadMessages() {
        if (!currentUser || !activePerson) {
            return;
        }

        const selectedPersonId = activePerson.id;

        $("#messages").innerHTML =
            '<div class="welcome">' +
            '<h2>Loading conversation…</h2>' +
            '</div>';

        /*
         * This query expects a messages table with:
         *
         * id
         * sender_id
         * receiver_id
         * content
         * attachment_path
         * attachment_name
         * attachment_type
         * attachment_size
         * created_at
         */

        const { data, error } = await supabase
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
                `and(sender_id.eq.${currentUser.id},receiver_id.eq.${selectedPersonId}),` +
                `and(sender_id.eq.${selectedPersonId},receiver_id.eq.${currentUser.id})`
            )
            .order("created_at", {
                ascending: true
            })
            .limit(300);

        if (error) {
            console.error("Unable to load messages:", error);

            $("#messages").innerHTML =
                '<div class="welcome">' +
                '<h2>Could not load messages</h2>' +
                '<p>Check your messages table, permissions, and database schema.</p>' +
                '</div>';

            return;
        }

        if (activePerson?.id !== selectedPersonId) {
            return;
        }

        messages = data || [];

        await renderMessages();
    }


    /* =====================================================
       15. REALTIME MESSAGE SUBSCRIPTION
    ===================================================== */

    function subscribeMessages() {
        if (!currentUser || !activePerson) {
            return;
        }

        const selectedPersonId = activePerson.id;

        messageChannel = supabase
            .channel(
                `messages:${[
                    currentUser.id,
                    selectedPersonId
                ].sort().join(":")}`
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

                    if (!message) {
                        return;
                    }

                    const relevant =
                        (
                            message.sender_id === currentUser.id &&
                            message.receiver_id === selectedPersonId
                        ) ||
                        (
                            message.sender_id === selectedPersonId &&
                            message.receiver_id === currentUser.id
                        );

                    if (!relevant) {
                        return;
                    }

                    if (!messages.some(
                        item => item.id === message.id
                    )) {
                        messages.push(message);

                        messages.sort(
                            (a, b) =>
                                new Date(a.created_at) -
                                new Date(b.created_at)
                        );

                        await renderMessages();
                    }
                }
            )
            .on(
                "broadcast",
                {
                    event: "typing"
                },
                ({ payload }) => {
                    if (
                        payload?.userId !== selectedPersonId ||
                        activePerson?.id !== selectedPersonId
                    ) {
                        return;
                    }

                    $("#typing-indicator")
                        .classList.remove("hidden");

                    clearTimeout(typingOffTimer);

                    typingOffTimer = setTimeout(() => {
                        $("#typing-indicator")
                            .classList.add("hidden");
                    }, 1600);
                }
            )
            .subscribe();
    }


    /* =====================================================
       16. RENDER MESSAGE HISTORY
    ===================================================== */

    async function renderMessages() {
        const box = $("#messages");

        if (!messages.length) {
            box.innerHTML = `
                <div class="welcome">
                    <div class="welcome-icon">✦</div>

                    <h2>Say hello</h2>

                    <p>
                        No messages yet.
                        Send the first message below.
                    </p>
                </div>
            `;

            return;
        }

        const selectedPerson = activePerson;

        const rendered = await Promise.all(
            messages.map(async message => {
                const mine =
                    message.sender_id === currentUser.id;

                let body = escapeHTML(
                    message.content || ""
                );

                if (message.attachment_path) {
                    let fileURL = null;

                    try {
                        const { data, error } = await supabase
                            .storage
                            .from("message-files")
                            .createSignedUrl(
                                message.attachment_path,
                                3600
                            );

                        if (!error && data?.signedUrl) {
                            fileURL = data.signedUrl;
                        }

                    } catch (error) {
                        console.error(
                            "Unable to create attachment link:",
                            error
                        );
                    }

                    const fileName =
                        message.attachment_name || "Shared file";

                    const fileDetails = message.attachment_size
                        ? formatSize(message.attachment_size)
                        : message.attachment_type || "Attachment";

                    if (body) {
                        body += "<br>";
                    }

                    if (fileURL) {
                        body += `
                            <a
                                class="attachment"
                                href="${escapeHTML(fileURL)}"
                                target="_blank"
                                rel="noopener noreferrer"
                            >
                                <span class="file-icon">↧</span>

                                <span>
                                    <strong>
                                        ${escapeHTML(fileName)}
                                    </strong>

                                    <small>
                                        ${escapeHTML(fileDetails)}
                                    </small>
                                </span>
                            </a>
                        `;
                    } else {
                        body += `
                            <div class="attachment">
                                <span class="file-icon">↧</span>

                                <span>
                                    <strong>
                                        ${escapeHTML(fileName)}
                                    </strong>

                                    <small>
                                        File unavailable or access denied
                                    </small>
                                </span>
                            </div>
                        `;
                    }
                }

                const person = mine
                    ? currentProfile
                    : selectedPerson;

                const author = mine
                    ? "You"
                    : (
                        selectedPerson?.display_name ||
                        selectedPerson?.username ||
                        "Member"
                    );

                return `
                    <article
                        class="message-row ${mine ? "mine" : ""}"
                    >
                        <img
                            src="${escapeHTML(getAvatar(person))}"
                            alt=""
                        >

                        <div class="message-content">

                            <div class="message-author">
                                ${escapeHTML(author)}
                            </div>

                            <div class="bubble">
                                ${body}
                            </div>

                            <div class="message-time">
                                ${escapeHTML(
                                    formatTime(message.created_at)
                                )}
                            </div>

                        </div>
                    </article>
                `;
            })
        );

        if (activePerson?.id !== selectedPerson?.id) {
            return;
        }

        box.innerHTML = rendered.join("");

        box.scrollTop = box.scrollHeight;
    }


    /* =====================================================
       17. SEND MESSAGES AND ATTACHMENTS
    ===================================================== */

    async function sendMessage(content = "", file = null) {
        if (
            !currentUser ||
            !activePerson ||
            sendingMessage
        ) {
            return;
        }

        content = content.trim();

        if (!content && !file) {
            return;
        }

        sendingMessage = true;

        $("#send-button").disabled = true;

        try {
            let attachment = {};

            if (file) {
                const maximumSize =
                    config.maxFileBytes || 15 * 1024 * 1024;

                if (file.size > maximumSize) {
                    throw new Error(
                        `File exceeds the ${formatSize(maximumSize)} limit.`
                    );
                }

                const safeName = file.name
                    .replace(/[^a-zA-Z0-9._-]/g, "_")
                    .slice(-120) || "file";

                const path =
                    `${currentUser.id}/${crypto.randomUUID()}-${safeName}`;

                const { error: uploadError } = await supabase
                    .storage
                    .from("message-files")
                    .upload(path, file, {
                        contentType:
                            file.type || "application/octet-stream",

                        upsert: false
                    });

                if (uploadError) {
                    throw uploadError;
                }

                attachment = {
                    attachment_path: path,
                    attachment_name: file.name,
                    attachment_type:
                        file.type || "application/octet-stream",
                    attachment_size: file.size
                };
            }

            const row = {
                sender_id: currentUser.id,
                receiver_id: activePerson.id,
                content,
                ...attachment
            };

            const { data, error } = await supabase
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

            if (error) {
                throw error;
            }

            if (!messages.some(item => item.id === data.id)) {
                messages.push(data);

                await renderMessages();
            }

            $("#message-input").value = "";
            $("#file-input").value = "";

            $("#message-input").style.height = "auto";

        } catch (error) {
            console.error("Sending message failed:", error);

            toast(
                "Message failed: " +
                (error.message || "Unknown error"),
                true
            );

        } finally {
            sendingMessage = false;

            $("#send-button").disabled = !activePerson;
        }
    }


    /* =====================================================
       18. THEME SWITCHING
    ===================================================== */

    function initializeTheme() {
        const savedTheme =
            localStorage.getItem("talkatch-theme");

        document.body.dataset.theme =
            savedTheme === "light" ? "light" : "dark";
    }


    function toggleTheme() {
        const nextTheme =
            document.body.dataset.theme === "light"
                ? "dark"
                : "light";

        document.body.dataset.theme = nextTheme;

        localStorage.setItem(
            "talkatch-theme",
            nextTheme
        );
    }


    /* =====================================================
       19. WEBRTC CALL SIGNALING
    ===================================================== */

    function newCallId() {
        return crypto.randomUUID();
    }


    function userCallChannel() {
        return supabase.channel(
            `user-calls:${currentUser.id}`,
            {
                config: {
                    broadcast: {
                        self: false
                    }
                }
            }
        );
    }


    function subscribeIncomingCalls() {
        if (incomingChannel) {
            supabase.removeChannel(incomingChannel);
        }

        incomingChannel = userCallChannel()
            .on(
                "broadcast",
                {
                    event: "invite"
                },
                ({ payload }) => {
                    if (
                        !payload ||
                        payload.to !== currentUser.id ||
                        currentCall
                    ) {
                        return;
                    }

                    incomingCall = payload;

                    const person = people.find(
                        item => item.id === payload.from
                    );

                    if (person) {
                        activePerson = person;

                        renderPeople();

                        $("#chat-title").textContent =
                            person.display_name ||
                            person.username ||
                            "Member";

                        $("#chat-avatar").src =
                            getAvatar(person);
                    }

                    showIncomingCall(payload);
                }
            )
            .on(
                "broadcast",
                {
                    event: "cancel"
                },
                ({ payload }) => {
                    if (
                        incomingCall?.callId === payload?.callId
                    ) {
                        incomingCall = null;

                        hideCallBanner();
                    }
                }
            )
            .subscribe();
    }


    function showIncomingCall(call) {
        $("#call-banner").classList.remove("hidden");

        $("#call-status").textContent =
            `Incoming ${call.type === "video" ? "video" : "voice"} call`;

        $("#call-detail").textContent =
            `${call.fromName || "A member"} is calling you.`;

        $("#accept-call").classList.remove("hidden");
        $("#decline-call").classList.remove("hidden");

        $("#end-call").classList.add("hidden");
    }


    function hideCallBanner() {
        $("#call-banner").classList.add("hidden");
    }


    async function inviteUser(recipientId, event, payload) {
        const channel = supabase.channel(
            `user-calls:${recipientId}`,
            {
                config: {
                    broadcast: {
                        self: false
                    }
                }
            }
        );

        try {
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(
                        new Error("Call signaling timed out.")
                    );
                }, 10000);

                channel.subscribe(status => {
                    if (status === "SUBSCRIBED") {
                        clearTimeout(timeout);
                        resolve();
                    }

                    if (status === "CHANNEL_ERROR") {
                        clearTimeout(timeout);

                        reject(
                            new Error("Call signaling channel failed.")
                        );
                    }
                });
            });

            const result = await channel.send({
                type: "broadcast",
                event,
                payload
            });

            if (result !== "ok") {
                throw new Error(
                    "Could not deliver call signal."
                );
            }

        } finally {
            await supabase.removeChannel(channel);
        }
    }


    /* =====================================================
       20. START CALL
    ===================================================== */

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
                peerName:
                    activePerson.display_name ||
                    activePerson.username ||
                    "Member"
            };

            await setupCallChannel();

            await preparePeer(type);

            await inviteUser(
                activePerson.id,
                "invite",
                {
                    callId: currentCall.callId,
                    type,
                    from: currentUser.id,
                    to: activePerson.id,
                    fromName:
                        currentProfile.display_name ||
                        currentProfile.username
                }
            );

            $("#call-banner").classList.remove("hidden");

            $("#call-status").textContent = "Calling…";

            $("#call-detail").textContent =
                `Waiting for ${currentCall.peerName} to answer.`;

            $("#accept-call").classList.add("hidden");
            $("#decline-call").classList.add("hidden");

            $("#end-call").classList.remove("hidden");

            await createOffer();

        } catch (error) {
            console.error("Unable to start call:", error);

            toast(
                "Could not start call: " +
                (error.message || "Unknown error"),
                true
            );

            await finishCall(false);
        }
    }


    /* =====================================================
       21. ACCEPT OR DECLINE CALL
    ===================================================== */

    async function acceptCall() {
        if (!incomingCall) {
            return;
        }

        const call = incomingCall;

        incomingCall = null;

        currentCall = {
            ...call,
            role: "callee",
            peerId: call.from,
            peerName: call.fromName || "Member"
        };

        hideCallBanner();

        try {
            await setupCallChannel();

            await preparePeer(call.type);

            $("#call-banner").classList.remove("hidden");

            $("#call-status").textContent = "Connected call";

            $("#call-detail").textContent =
                "Connecting audio and video…";

            $("#accept-call").classList.add("hidden");
            $("#decline-call").classList.add("hidden");

            $("#end-call").classList.remove("hidden");

        } catch (error) {
            console.error("Unable to accept call:", error);

            toast(
                "Could not accept call: " +
                (error.message || "Unknown error"),
                true
            );

            await finishCall(false);
        }
    }


    async function declineCall() {
        if (incomingCall) {
            try {
                await inviteUser(
                    incomingCall.from,
                    "cancel",
                    {
                        callId: incomingCall.callId,
                        from: currentUser.id
                    }
                );
            } catch (error) {
                console.error(error);
            }

            incomingCall = null;
        }

        hideCallBanner();
    }


    /* =====================================================
       22. CALL SIGNAL CHANNEL
    ===================================================== */

    async function setupCallChannel() {
        if (callChannel) {
            await supabase.removeChannel(callChannel);
        }

        const callId = currentCall.callId;

        callChannel = supabase
            .channel(`call:${callId}`, {
                config: {
                    broadcast: {
                        self: false
                    }
                }
            })
            .on(
                "broadcast",
                {
                    event: "signal"
                },
                async ({ payload }) => {
                    if (
                        !payload ||
                        payload.from === currentUser.id ||
                        payload.callId !== currentCall?.callId
                    ) {
                        return;
                    }

                    try {
                        if (payload.description) {
                            await peerConnection.setRemoteDescription(
                                payload.description
                            );

                            if (
                                payload.description.type === "offer"
                            ) {
                                const answer =
                                    await peerConnection.createAnswer();

                                await peerConnection.setLocalDescription(
                                    answer
                                );

                                await sendSignal({
                                    description:
                                        peerConnection.localDescription
                                });
                            }
                        }

                        if (payload.candidate) {
                            await peerConnection.addIceCandidate(
                                payload.candidate
                            );
                        }

                    } catch (error) {
                        console.error(
                            "Call signaling error:",
                            error
                        );

                        toast(
                            "Call connection issue: " +
                            error.message,
                            true
                        );
                    }
                }
            )
            .on(
                "broadcast",
                {
                    event: "accepted"
                },
                async ({ payload }) => {
                    if (
                        currentCall?.role !== "caller" ||
                        payload?.callId !== currentCall.callId
                    ) {
                        return;
                    }

                    $("#call-status").textContent = "Call accepted";

                    $("#call-detail").textContent =
                        "Connecting audio and video…";
                }
            )
            .on(
                "broadcast",
                {
                    event: "ended"
                },
                ({ payload }) => {
                    if (
                        payload?.callId === currentCall?.callId
                    ) {
                        finishCall(false);
                    }
                }
            )
            .subscribe(async status => {
                if (
                    status === "SUBSCRIBED" &&
                    currentCall?.role === "callee"
                ) {
                    await sendSignal({
                        accepted: true
                    });
                }
            });
    }


    async function sendSignal(extra) {
        if (!callChannel || !currentCall) {
            return;
        }

        const event = extra.accepted
            ? "accepted"
            : extra.ended
                ? "ended"
                : "signal";

        const result = await callChannel.send({
            type: "broadcast",
            event,
            payload: {
                ...extra,
                callId: currentCall.callId,
                from: currentUser.id
            }
        });

        if (result !== "ok") {
            console.warn("Call signal was not confirmed.");
        }
    }


    /* =====================================================
       23. PREPARE AUDIO AND VIDEO
    ===================================================== */

    async function preparePeer(type) {
        if (!navigator.mediaDevices?.getUserMedia) {
            throw new Error(
                "Camera and microphone access requires HTTPS or localhost."
            );
        }

        localStream =
            await navigator.mediaDevices.getUserMedia({
                audio: true,
                video: type === "video"
            });

        remoteStream = new MediaStream();

        $("#local-video").srcObject = localStream;
        $("#remote-video").srcObject = remoteStream;

        $("#call-stage").classList.remove("hidden");

        peerConnection = new RTCPeerConnection({
            iceServers:
                config.iceServers || [
                    {
                        urls: "stun:stun.l.google.com:19302"
                    }
                ]
        });

        localStream.getTracks().forEach(track => {
            peerConnection.addTrack(track, localStream);
        });

        peerConnection.ontrack = event => {
            event.streams[0]?.getTracks().forEach(track => {
                remoteStream.addTrack(track);
            });

            $("#remote-video").srcObject = remoteStream;
        };

        peerConnection.onicecandidate = event => {
            if (event.candidate) {
                sendSignal({
                    candidate: event.candidate.toJSON()
                });
            }
        };

        peerConnection.onconnectionstatechange = () => {
            const state = peerConnection?.connectionState;

            if (state === "connected") {
                $("#call-status").textContent = "Connected";
            }

            if (state === "failed") {
                toast(
                    "Call failed. A TURN server may be needed for your network.",
                    true
                );
            }
        };

        callStartedAt = Date.now();

        clearInterval(callTimer);

        callTimer = setInterval(() => {
            if (!callStartedAt) {
                return;
            }

            const elapsed = Math.floor(
                (Date.now() - callStartedAt) / 1000
            );

            const minutes = String(
                Math.floor(elapsed / 60)
            ).padStart(2, "0");

            const seconds = String(
                elapsed % 60
            ).padStart(2, "0");

            $("#call-clock").textContent =
                `${minutes}:${seconds}`;

        }, 1000);

        $("#call-clock").textContent = "00:00";
    }


    async function createOffer() {
        if (!peerConnection) {
            throw new Error("Call connection is not ready.");
        }

        const offer =
            await peerConnection.createOffer();

        await peerConnection.setLocalDescription(offer);

        await sendSignal({
            description: peerConnection.localDescription
        });
    }


    /* =====================================================
       24. CALL CONTROLS
    ===================================================== */

    async function finishCall(notifyPeer = true) {
        const oldCall = currentCall;

        currentCall = null;
        incomingCall = null;

        clearInterval(callTimer);

        callTimer = null;
        callStartedAt = null;

        if (notifyPeer && oldCall) {
            try {
                if (callChannel) {
                    await callChannel.send({
                        type: "broadcast",
                        event: "ended",
                        payload: {
                            callId: oldCall.callId,
                            from: currentUser.id
                        }
                    });
                }
            } catch (error) {
                console.error(
                    "Unable to notify other caller:",
                    error
                );
            }
        }

        if (peerConnection) {
            peerConnection.ontrack = null;
            peerConnection.onicecandidate = null;

            peerConnection.close();

            peerConnection = null;
        }

        if (localStream) {
            localStream.getTracks().forEach(track => {
                track.stop();
            });

            localStream = null;
        }

        if (remoteStream) {
            remoteStream.getTracks().forEach(track => {
                track.stop();
            });

            remoteStream = null;
        }

        $("#local-video").srcObject = null;
        $("#remote-video").srcObject = null;

        $("#call-stage").classList.add("hidden");

        hideCallBanner();

        $("#mute-call").textContent = "Mute mic";
        $("#camera-call").textContent = "Camera off";

        if (callChannel) {
            await supabase.removeChannel(callChannel);

            callChannel = null;
        }
    }


    function toggleMute() {
        if (!localStream) {
            return;
        }

        const track = localStream.getAudioTracks()[0];

        if (!track) {
            return;
        }

        track.enabled = !track.enabled;

        $("#mute-call").textContent = track.enabled
            ? "Mute mic"
            : "Unmute mic";
    }


    function toggleCamera() {
        if (!localStream) {
            return;
        }

        const track = localStream.getVideoTracks()[0];

        if (!track) {
            return;
        }

        track.enabled = !track.enabled;

        $("#camera-call").textContent = track.enabled
            ? "Camera off"
            : "Camera on";
    }


    /* =====================================================
       25. LOGOUT AND CLEANUP
    ===================================================== */

    async function logout() {
        if (loggingOut) {
            return;
        }

        loggingOut = true;

        try {
            await finishCall(false);

            if (messageChannel) {
                await supabase.removeChannel(messageChannel);
                messageChannel = null;
            }

            if (incomingChannel) {
                await supabase.removeChannel(incomingChannel);
                incomingChannel = null;
            }

            const { error } = await supabase.auth.signOut();

            if (error) {
                throw error;
            }

            currentUser = null;
            currentProfile = null;
            activePerson = null;

            people = [];
            messages = [];

            showAuth();

            showAuthTab("login");

        } catch (error) {
            console.error("Logout failed:", error);

            toast(
                "Unable to log out: " +
                (error.message || "Unknown error"),
                true
            );

        } finally {
            loggingOut = false;
        }
    }


    /* =====================================================
       26. EVENT LISTENERS
    ===================================================== */

    function wireEvents() {

        /* Avatar upload */

        $("#my-avatar").addEventListener("click", () => {
            $("#avatar-upload").click();
        });

        $("#my-avatar").addEventListener("keydown", event => {
            if (
                event.key === "Enter" ||
                event.key === " "
            ) {
                event.preventDefault();

                $("#avatar-upload").click();
            }
        });

        $("#avatar-upload").addEventListener("change", event => {
            const file = event.target.files?.[0];

            if (file) {
                uploadAvatar(file);
            }

            event.target.value = "";
        });


        /* Authentication tabs */

        $$("[data-tab]").forEach(button => {
            button.addEventListener("click", () => {
                showAuthTab(button.dataset.tab);
            });
        });


        /* Login and registration */

        $("#login-form").addEventListener("submit", event => {
            event.preventDefault();

            login(event.currentTarget);
        });

        $("#signup-form").addEventListener("submit", event => {
            event.preventDefault();

            signup(event.currentTarget);
        });

        $("#forgot-password").addEventListener(
            "click",
            resetPassword
        );


        /* Application controls */

        $("#logout-button").addEventListener(
            "click",
            logout
        );

        $("#theme-button").addEventListener(
            "click",
            toggleTheme
        );

        $("#refresh-users").addEventListener(
            "click",
            loadPeople
        );

        $("#user-search").addEventListener(
            "input",
            renderPeople
        );


        /* Open a conversation */

        $("#people-list").addEventListener(
            "click",
            event => {
                const button = event.target.closest(
                    "[data-person]"
                );

                if (button) {
                    openPerson(button.dataset.person);
                }
            }
        );


        /* Send a message */

        $("#message-form").addEventListener(
            "submit",
            event => {
                event.preventDefault();

                const text = $("#message-input").value;
                const file = $("#file-input").files?.[0] || null;

                sendMessage(text, file);
            }
        );


        /* Attachment selection */

        $("#file-input").addEventListener(
            "change",
            () => {
                const file = $("#file-input").files?.[0];

                if (file) {
                    toast(
                        `Selected ${file.name} (${formatSize(file.size)}). Press Send to upload it.`
                    );
                }
            }
        );


        /* Message input and typing */

        $("#message-input").addEventListener(
            "keydown",
            event => {
                if (
                    event.key === "Enter" &&
                    !event.shiftKey
                ) {
                    event.preventDefault();

                    $("#message-form").requestSubmit();
                }
            }
        );

        $("#message-input").addEventListener(
            "input",
            event => {
                const textarea = event.target;

                textarea.style.height = "auto";

                textarea.style.height =
                    Math.min(textarea.scrollHeight, 130) + "px";

                if (activePerson && messageChannel) {
                    clearTimeout(typingTimer);

                    messageChannel.send({
                        type: "broadcast",
                        event: "typing",
                        payload: {
                            userId: currentUser.id
                        }
                    });

                    typingTimer = setTimeout(() => {}, 500);
                }
            }
        );


        /* Voice and video calls */

        $("#voice-call").addEventListener(
            "click",
            () => startCall("audio")
        );

        $("#video-call").addEventListener(
            "click",
            () => startCall("video")
        );

        $("#accept-call").addEventListener(
            "click",
            acceptCall
        );

        $("#decline-call").addEventListener(
            "click",
            declineCall
        );

        $("#end-call").addEventListener(
            "click",
            () => finishCall(true)
        );

        $("#hangup-call").addEventListener(
            "click",
            () => finishCall(true)
        );

        $("#mute-call").addEventListener(
            "click",
            toggleMute
        );

        $("#camera-call").addEventListener(
            "click",
            toggleCamera
        );


        /* Keyboard shortcuts */

        document.addEventListener("keydown", event => {
            if (
                event.key === "Escape" &&
                currentCall
            ) {
                finishCall(true);
            }
        });


        /* Theme */

        initializeTheme();
    }


    /* =====================================================
       27. INITIALIZE SUPABASE
    ===================================================== */

    async function initialize() {
        wireEvents();

        if (
            !config.supabaseUrl ||
            !config.supabaseAnonKey ||
            config.supabaseAnonKey.includes("YOUR_SUPABASE")
        ) {
            showAuth();

            showAuthMessage(
                "Open config.js and add your Supabase project URL and publishable/anon key.",
                true
            );

            return;
        }

        if (!window.supabase?.createClient) {
            showAuth();

            showAuthMessage(
                "Supabase did not load. Check your internet connection.",
                true
            );

            return;
        }

        supabase = window.supabase.createClient(
            config.supabaseUrl,
            config.supabaseAnonKey
        );

        try {
            const { data, error } =
                await supabase.auth.getSession();

            if (error) {
                throw error;
            }

            if (data.session?.user) {
                await startApplication(data.session.user);
            } else {
                showAuth();
            }

        } catch (error) {
            console.error(
                "Unable to restore session:",
                error
            );

            showAuth();

            showAuthMessage(
                error.message || "Unable to restore your session.",
                true
            );
        }

        supabase.auth.onAuthStateChange(
            (event, session) => {
                if (
                    event === "SIGNED_IN" &&
                    session?.user &&
                    currentUser?.id !== session.user.id &&
                    !startingApp
                ) {
                    setTimeout(() => {
                        startApplication(session.user);
                    }, 0);
                }

                if (event === "SIGNED_OUT") {
                    currentUser = null;
                    currentProfile = null;
                    activePerson = null;

                    showAuth();
                }

                if (event === "PASSWORD_RECOVERY") {
                    showAuthMessage(
                        "Password recovery opened. Follow the instructions from your email."
                    );
                }
            }
        );
    }


    /* =====================================================
       28. STARTUP
    ===================================================== */

    document.addEventListener(
        "DOMContentLoaded",
        initialize
    );

})();
