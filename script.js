"use strict";

const createFamilyButton = document.getElementById("create-family");
const joinFamilyButton = document.getElementById("join-family");
const modalContent = document.getElementById("modal-content");
const modalOverlay = document.getElementById("modal-overlay");
const closeModalButton = document.getElementById("close-modal");

const TAB_TOKEN_KEY = "kharidyar_tab_token";

let currentFamilyId = null;
let currentFamilyName = "";
let activeFamilyData = null;
let familyMembers = [];
let products = [];
let shoppingItems = [];
let myRequests = [];
let currentPage = "shopping";
let messageTimer = null;
let pageRenderId = 0;
let confirmationResolver = null;
let requestRefreshTimer = null;
let lastPendingRequestCount = null;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, char => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    })[char]);
}

function showMessage(message, type = "info") {
    let box = $("#message-box");

    if (!box) {
        box = document.createElement("div");
        box.id = "message-box";
        document.body.appendChild(box);
    }

    box.textContent = message;
    box.className = `show ${type}`;

    clearTimeout(messageTimer);

    messageTimer = setTimeout(() => {
        box.className = "";
    }, 3500);
}
function showModal(html) {
    if (confirmationResolver) {
        const resolvePrevious = confirmationResolver;
        confirmationResolver = null;
        resolvePrevious(false);
    }

    modalContent.innerHTML = html;
    modalOverlay.hidden = false;
    document.body.classList.add("modal-open");
}
function confirmInSite(message, title = "تأیید عملیات") {
    return new Promise(resolve => {
        // لغو پنجره تأیید قبلی، اگر هنوز باز باشد
        if (confirmationResolver) {
            const previousResolver = confirmationResolver;
            confirmationResolver = null;
            previousResolver(false);
        }

        // اول پنجره را نمایش می‌دهیم
        showModal(`
            <div class="site-confirmation"
                 role="alertdialog"
                 aria-modal="true"
                 aria-labelledby="modal-title">

                <h2 id="modal-title">
                    ${escapeHTML(title)}
                </h2>

                <p class="modal-description">
                    ${escapeHTML(message)}
                </p>

                <div class="confirmation-actions">
                    <button
                        type="button"
                        class="button secondary"
                        data-confirm-choice="cancel">
                        انصراف
                    </button>

                    <button
                        type="button"
                        class="button primary"
                        data-confirm-choice="confirm">
                        تأیید
                    </button>
                </div>
            </div>
        `);

        // بعد از نمایش پنجره، پاسخ را ذخیره می‌کنیم
        confirmationResolver = resolve;
    });
}function closeModal() {
    modalOverlay.hidden = true;
    modalContent.innerHTML = "";
    document.body.classList.remove("modal-open");
}

closeModalButton.addEventListener("click", closeModal);

modalOverlay.addEventListener("click", event => {
    if (event.target === modalOverlay) {
        closeModal();
    }
});

document.addEventListener("keydown", event => {
    if (event.key === "Escape") closeModal();
});

function jsonOptions(method = "GET", body) {
    return {
        method,
        credentials: "same-origin",
        headers: {
            "Content-Type": "application/json"
        },
        ...(body === undefined ? {} : {
            body: JSON.stringify(body)
        })
    };
}

/* =========================
   ارتباط با سرور
========================= */

async function apiRequest(url, options = {}) {
    const headers = new Headers(options.headers || {});

    const isAuthenticationRequest =
        url === "/api/login" ||
        url === "/api/activate";

    if (isAuthenticationRequest) {
        headers.delete("Authorization");
    } else {
        const token = sessionStorage.getItem(TAB_TOKEN_KEY);

        if (token) {
            headers.set("Authorization", `Bearer ${token}`);
        } else {
            headers.delete("Authorization");
        }
    }

    let response;

    try {
        response = await fetch(url, {
            ...options,
            headers,
            credentials: "same-origin"
        });
    } catch {
        throw new Error(
            "ارتباط با سرور برقرار نشد. اجرای Flask را بررسی کن."
        );
    }

    const data = await response.json().catch(() => ({}));

    if (!response.ok || data.success === false) {
        throw new Error(data.message || "عملیات انجام نشد.");
    }

    return data;
}

function familyApi(path, options) {
    if (!currentFamilyId) {
        throw new Error("خانواده‌ای انتخاب نشده است.");
    }

    return apiRequest(
        `/api/families/${currentFamilyId}/${path}`,
        options
    );
}

function normalizeMember(member) {
    return {
        ...member,
        isApprover: Boolean(
            member.isApprover ?? member.is_approver
        )
    };
}

function isApprover() {
    const member = activeFamilyData?.member;

    return Boolean(
        member?.isApprover ?? member?.is_approver
    );
}

function currentMemberId() {
    return Number(activeFamilyData?.member?.id || 0);
}

function requestTypeLabel(type) {
    const labels = {
        add_product: "افزودن کالا به فهرست کالاها",
        add_item: "افزودن کالا به فهرست خرید",
        delete_item: "حذف از فهرست خرید",
        delete_product: "حذف از فهرست کالاها",
        edit_item: "ویرایش کالای فهرست خرید"
    };

    return labels[type] || type || "درخواست";
}

function requestStatusLabel(status) {
    const labels = {
        pending: "در انتظار بررسی",
        approved: "تأیید شده",
        rejected: "رد شده"
    };

    return labels[status] || status || "نامشخص";
}

function requestStatusClass(status) {
    if (status === "approved") return "success";
    if (status === "rejected") return "danger";
    return "pending";
}

function updateNotificationBadge(button, count) {
    if (!button) return;

    let badge = button.querySelector(".request-count-badge");

    if (!count || count < 1) {
        badge?.remove();
        return;
    }

    if (!badge) {
        badge = document.createElement("span");
        badge.className = "request-count-badge";
        button.appendChild(badge);
    }

    badge.textContent = count > 99 ? "99+" : String(count);
    badge.setAttribute("aria-label", `${count} درخواست در انتظار`);
}

function clearNotificationBadge(selector) {
    document.querySelectorAll(selector).forEach(button => {
        button.querySelector(".request-count-badge")?.remove();
    });
}
async function refreshNotificationBadges() {
    if (!currentFamilyId || !activeFamilyData?.member) return;

    try {
        if (isApprover()) {
            const result = await familyApi("requests");

            const requests = (result.requests || []).filter(
                request => request.status === "pending"
            );

            const sections = {
                add: {
                    selector: '[data-page="requests-add"]',
                    types: ["add_product", "add_item"]
                },
                delete: {
                    selector: '[data-page="requests-delete"]',
                    types: ["delete_item", "delete_product"]
                },
                edit: {
                    selector: '[data-page="requests-edit"]',
                    types: ["edit_item"]
                }
            };

            let totalUnviewed = 0;

            for (const [section, config] of Object.entries(sections)) {
                const count = requests.filter(request =>
                    config.types.includes(request.request_type)
                ).length;

                if (viewedRequestSections.has(section)) {
                    updateNotificationBadge(
                        $(config.selector),
                        0
                    );
                } else {
                    totalUnviewed += count;

                    updateNotificationBadge(
                        $(config.selector),
                        count
                    );
                }
            }

            updateNotificationBadge(
                $('[data-page="requests"]'),
                totalUnviewed
            );
        } else {
            const result = await familyApi("my-requests");

            const pending = (result.requests || []).filter(
                request => request.status === "pending"
            );

            updateNotificationBadge(
                $('[data-page="my-requests"]'),
                pending.length
            );
        }
    } catch (err) {
        console.error("خطا در به‌روزرسانی اعلان‌ها:", err);
    }
}const viewedRequestSections = new Set();
let notificationTimer = null;

function startNotificationUpdates() {
    if (notificationTimer !== null) {
        clearInterval(notificationTimer);
    }

    refreshNotificationBadges();

    notificationTimer = setInterval(() => {
        refreshNotificationBadges();
    }, 10000);
}

function stopNotificationUpdates() {
    if (notificationTimer !== null) {
        clearInterval(notificationTimer);
        notificationTimer = null;
    }
}

function roleLabel(role) {
    return role || "عضو خانواده";
}

/* =========================
   پروفایل
========================= */

function showProfileMenus(visible) {
    $$(".profile-menu").forEach(menu => {
        menu.hidden = !visible;
    });
}

function closeProfileMenus() {
    $$(".profile-dropdown").forEach(dropdown => {
        dropdown.hidden = true;
    });

    $$(".profile-menu-button").forEach(button => {
        button.setAttribute("aria-expanded", "false");
    });
}

document.addEventListener("click", async event => {
    const profileButton = event.target.closest(".profile-menu-button");

    if (profileButton) {
        const dropdown = $(".profile-dropdown", profileButton.parentElement);

        if (!dropdown) return;

        const shouldOpen = dropdown.hidden;

        closeProfileMenus();
        dropdown.hidden = !shouldOpen;

        profileButton.setAttribute(
            "aria-expanded",
            String(shouldOpen)
        );

        return;
    }

    const profileAction = event.target.closest("[data-profile-action]");

    if (profileAction) {
        closeProfileMenus();

        if (profileAction.dataset.profileAction === "settings") {
            openSettings();
        } else if (
            profileAction.dataset.profileAction === "change-password"
        ) {
            openChangePassword();
        } else if (
            profileAction.dataset.profileAction === "logout"
        ) {
            await logout();
        }

        return;
    }

    if (!event.target.closest(".profile-menu")) {
        closeProfileMenus();
    }
});

/* =========================
   ساخت خانواده
========================= */

createFamilyButton.addEventListener("click", () => {
    showModal(`
        <h2 id="modal-title">ساخت خانواده</h2>

        <form id="family-first-form" class="form-stack">
            <label>
                نام خانواده
                <input name="familyName" maxlength="50" required>
            </label>

            <label>
                تعداد اعضا
                <select name="count" required>
                    ${Array.from({ length: 19 }, (_, i) => `
                        <option value="${i + 2}">
                            ${i + 2} نفر
                        </option>
                    `).join("")}
                </select>
            </label>

            <button class="button primary" type="submit">ادامه</button>
        </form>
    `);
});

function renderCreateMembers(familyName, count) {
    const members = Array.from({ length: count }, (_, i) => `
        <div class="member-input-card">
            <h3>عضو ${i + 1}</h3>

            <label>
                نام نمایشی
                <input name="name_${i}" maxlength="40" required>
            </label>

            <div class="form-two">
                <label>
                    نقش
                    <select name="role_${i}">
                        <option>فرزند</option>
                        <option>پدر</option>
                        <option>مادر</option>
                        <option>سایر اعضا</option>
                    </select>
                </label>

                <label>
                    جنسیت
                    <select name="gender_${i}">
                        <option>مرد</option>
                        <option>زن</option>
                    </select>
                </label>
            </div>

            <label class="check-label">
                <input
                    type="checkbox"
                    name="approver_${i}"
                    ${i === 0 ? "checked" : ""}
                >
                اجازهٔ تأیید درخواست‌ها
            </label>
        </div>
    `).join("");

    showModal(`
        <h2 id="modal-title">اعضای خانواده</h2>

        <form id="family-members-form" class="form-stack">
            <input type="hidden" name="familyName"
                   value="${escapeHTML(familyName)}">
            <input type="hidden" name="count" value="${count}">

            <div class="member-input-grid">${members}</div>

            <button class="button primary" type="submit">
                ساخت خانواده
            </button>
        </form>
    `);
}

async function submitFamilyCreation(form) {
    const fd = new FormData(form);
    const familyName = String(fd.get("familyName") || "").trim();
    const count = Number(fd.get("count"));

    const members = [];

    for (let i = 0; i < count; i++) {
        members.push({
            name: String(fd.get(`name_${i}`) || "").trim(),
            gender: fd.get(`gender_${i}`),
            role: fd.get(`role_${i}`),
            isApprover: fd.get(`approver_${i}`) === "on"
        });
    }

    const result = await apiRequest(
        "/api/families",
        jsonOptions("POST", { familyName, members })
    );

    familyMembers = (result.members || []).map(normalizeMember);

    const codeRows = (result.members || []).map(member => `
        <div class="code-row">
            <span>${escapeHTML(member.name)}</span>
            <code>${escapeHTML(member.code)}</code>
            <button
                type="button"
                class="text-button"
                data-copy-code="${escapeHTML(member.code)}"
            >کپی</button>
        </div>
    `).join("");

    const memberOptions = (result.members || []).map((member, index) => `
        <option value="${index}">
            ${escapeHTML(member.name)} — ${escapeHTML(member.role)}
            ${member.isApprover ? " · تأییدکننده" : ""}
        </option>
    `).join("");

    showModal(`
        <h2 id="modal-title">خانواده ساخته شد</h2>

        <p class="modal-description">
            کد عضویت هر شخص را به خودش بدهید.
            هر کد فقط برای اولین فعال‌سازی است.
        </p>

        <button type="button" class="button secondary"
                data-copy-all-codes>
            کپی همهٔ کدها
        </button>

        <div id="all-codes-message"
             class="all-codes-message" hidden></div>

        <div class="code-list">${codeRows}</div>

        <form id="creator-select-form" class="form-stack">
            <label>
                حسابی که می‌خواهید فعال کنید
                <select name="memberIndex">${memberOptions}</select>
            </label>

            <button class="button primary" type="submit">ادامه</button>
        </form>
    `);
}

/* =========================
   ورود و فعال‌سازی
========================= */

joinFamilyButton.addEventListener("click", () => {
    showAuthModal("login");
});

function showAuthModal(mode = "login") {
    const loginMode = mode === "login";

    showModal(`
        <h2 id="modal-title">ورود به خانواده</h2>

        <div class="modal-tabs">
            <button type="button" data-auth-tab="login"
                    class="${loginMode ? "active" : ""}">
                ورود با رمز
            </button>

            <button type="button" data-auth-tab="activate"
                    class="${!loginMode ? "active" : ""}">
                اولین ورود با کد
            </button>
        </div>

        <form id="login-form" class="form-stack"
              ${loginMode ? "" : "hidden"}>
            <p class="modal-description">
                برای ورود از نام کاربری و رمز عبورت استفاده کن.
            </p>

            <label>
                نام کاربری
                <input name="username" minlength="3" maxlength="24"
                       autocomplete="username" required>
            </label>

            <label>
                رمز عبور
                <input name="password" type="password"
                       autocomplete="current-password" required>
            </label>

            <button class="button primary" type="submit">ورود</button>
        </form>

        <form id="activation-form" class="form-stack"
              ${loginMode ? "hidden" : ""}>
            <p class="modal-description">
                کد عضویت را برای اولین فعال‌سازی استفاده کن.
                بعداً با نام کاربری و رمز وارد شو.
            </p>

            <label>
                کد عضویت ۶ رقمی
                <input name="code" inputmode="numeric"
                       pattern="[0-9]{6}" maxlength="6" required>
            </label>

            <label>
                نام کاربری
                <input name="username"
                       pattern="[A-Za-z0-9_.-]{3,24}"
                       minlength="3" maxlength="24"
                       autocomplete="username" required>
            </label>

            <label>
                رمز عبور
                <input name="password" type="password"
                       minlength="8" maxlength="128"
                       autocomplete="new-password" required>
            </label>

            <button class="button primary" type="submit">
                فعال‌سازی و ورود
            </button>
        </form>
    `);
}

function showActivationForCreator(member) {
    showModal(`
        <h2 id="modal-title">فعال‌سازی حساب</h2>

        <p class="modal-description">
            برای حساب «${escapeHTML(member.name)}» نام کاربری و رمز بساز.
            ${member.isApprover
                ? "این حساب اجازهٔ تأیید درخواست‌ها را دارد."
                : "این حساب اجازهٔ تأیید درخواست‌ها را ندارد."}
        </p>

        <form id="activation-form" class="form-stack">
            <input type="hidden" name="code"
                   value="${escapeHTML(member.code)}">

            <label>
                نام کاربری
                <input name="username"
                       pattern="[A-Za-z0-9_.-]{3,24}"
                       minlength="3" maxlength="24" required>
            </label>

            <label>
                رمز عبور
                <input name="password" type="password"
                       minlength="8" maxlength="128" required>
            </label>

            <button class="button primary" type="submit">
                فعال‌سازی و ورود
            </button>
        </form>
    `);
}

/* =========================
   مدیریت فرم‌ها
========================= */

document.addEventListener("submit", async event => {
    const form = event.target;

    if (!(form instanceof HTMLFormElement)) return;

    if (form.id === "family-first-form") {
        event.preventDefault();

        const fd = new FormData(form);
        const familyName = String(fd.get("familyName") || "").trim();
        const count = Number(fd.get("count"));

        if (!familyName || count < 2 || count > 20) {
            showMessage("اطلاعات خانواده معتبر نیست.", "error");
            return;
        }

        renderCreateMembers(familyName, count);
        return;
    }

    if (form.id === "family-members-form") {
        event.preventDefault();

        try {
            await submitFamilyCreation(form);
        } catch (err) {
            showMessage(err.message, "error");
        }

        return;
    }

    if (form.id === "creator-select-form") {
        event.preventDefault();

        const index = Number(new FormData(form).get("memberIndex"));
        const member = familyMembers[index];

        if (!member) {
            showMessage("عضو انتخاب‌شده پیدا نشد.", "error");
            return;
        }

        showActivationForCreator(member);
        return;
    }

    if (form.id === "activation-form") {
        event.preventDefault();

        const fd = new FormData(form);
        const submit = $('button[type="submit"]', form);

        submit.disabled = true;

        try {
            const result = await apiRequest(
                "/api/activate",
                jsonOptions("POST", {
                    code: String(fd.get("code") || "").trim(),
                    username: String(fd.get("username") || "").trim(),
                    password: fd.get("password")
                })
            );

            closeModal();
            await enterFamily(result);

            showMessage(
                "حساب فعال شد. نام کاربری و رمز را نگه دار.",
                "success"
            );
        } catch (err) {
            showMessage(err.message, "error");
        } finally {
            submit.disabled = false;
        }

        return;
    }

    if (form.id === "login-form") {
        event.preventDefault();

        const fd = new FormData(form);
        const submit = $('button[type="submit"]', form);

        submit.disabled = true;

        try {
            const result = await apiRequest(
                "/api/login",
                jsonOptions("POST", {
                    username: String(fd.get("username") || "").trim(),
                    password: fd.get("password")
                })
            );

            closeModal();
            await enterFamily(result);
            showMessage("با موفقیت وارد شدی.", "success");
        } catch (err) {
            showMessage(err.message, "error");
        } finally {
            submit.disabled = false;
        }

        return;
    }

    if (form.id === "settings-form") {
        event.preventDefault();

        const fd = new FormData(form);
        const submit = $('button[type="submit"]', form);
        submit.disabled = true;

        try {
            const result = await apiRequest(
                "/api/account",
                jsonOptions("PATCH", {
                    username: String(fd.get("username") || "").trim()
                })
            );

            activeFamilyData = {
                ...result,
                member: result.member
                    ? normalizeMember(result.member)
                    : result.member
            };

            familyMembers = (result.familyMembers || []).map(normalizeMember);
            currentFamilyName = result.familyName;

            updateFamilyHeader();
            setupFamilyNavigation();
            closeModal();

            showMessage("نام کاربری ذخیره شد.", "success");
            renderFamilyPage(currentPage);
        } catch (err) {
            showMessage(err.message, "error");
        } finally {
            submit.disabled = false;
        }

        return;
    }

    if (form.id === "change-password-form") {
        event.preventDefault();

        const fd = new FormData(form);
        const password = String(fd.get("password") || "");
        const confirmPassword = String(fd.get("confirmPassword") || "");
        const submit = $('button[type="submit"]', form);

        if (password !== confirmPassword) {
            showMessage("رمز جدید و تکرار آن یکسان نیستند.", "error");
            return;
        }

        if (password.length < 8 || password.length > 128) {
            showMessage("رمز باید بین ۸ تا ۱۲۸ نویسه باشد.", "error");
            return;
        }

        submit.disabled = true;

        try {
            await apiRequest(
                "/api/change-password",
                jsonOptions("POST", {
                    password,
                    confirmPassword
                })
            );

            closeModal();
            showMessage("رمز عبور با موفقیت تغییر کرد.", "success");
        } catch (err) {
            showMessage(err.message, "error");
        } finally {
            submit.disabled = false;
        }

        return;
    }

    if (form.id === "product-form") {
        event.preventDefault();

        const fd = new FormData(form);
        const submit = $('button[type="submit"]', form);
        submit.disabled = true;

        try {
            const result = await familyApi(
                "products",
                jsonOptions("POST", {
                    name: String(fd.get("name") || "").trim(),
                    description: String(fd.get("description") || "").trim()
                })
            );

            showMessage(result.message || "عملیات انجام شد.", "success");

            await refreshFamilyData();
            renderFamilyPage("products");
        } catch (err) {
            showMessage(err.message, "error");
        } finally {
            submit.disabled = false;
        }

        return;
    }

    if (form.id === "edit-item-form") {
        event.preventDefault();

        const fd = new FormData(form);
        const itemId = form.dataset.itemId;
        const submit = $('button[type="submit"]', form);

        const name = String(fd.get("name") || "").trim();
        const description = String(fd.get("description") || "").trim();

        if (!name) {
            showMessage("عنوان کالا را وارد کن.", "error");
            return;
        }

        submit.disabled = true;

        try {
            const result = await familyApi(
                `shopping-items/${itemId}`,
                jsonOptions("PATCH", { name, description })
            );

            closeModal();

            showMessage(
                result.message || (
                    result.approved
                        ? "کالا ویرایش شد."
                        : "درخواست ویرایش برای تأیید ارسال شد."
                ),
                "success"
            );

            await refreshFamilyData();
            renderFamilyPage(currentPage);
        } catch (err) {
            showMessage(err.message, "error");
        } finally {
            submit.disabled = false;
        }

        return;
    }
});

/* =========================
   کپی کد عضویت
========================= */

document.addEventListener("click", async event => {
    const confirmationButton = event.target.closest(
        "[data-confirm-choice]"
    );

    if (confirmationButton) {
        const approved =
            confirmationButton.dataset.confirmChoice === "confirm";

        const resolveConfirmation = confirmationResolver;
        confirmationResolver = null;

        closeModal();

        if (resolveConfirmation) {
            resolveConfirmation(approved);
        }

        return;
    }

    const tab = event.target.closest("[data-auth-tab]");
    if (tab) {
        showAuthModal(tab.dataset.authTab);
        return;
    }

    const copyAllButton = event.target.closest("[data-copy-all-codes]");

    if (copyAllButton) {
        const membersWithCodes = familyMembers.filter(member => member.code);

        const text = membersWithCodes
            .map(member =>
                `${member.name} (${member.role}): ${member.code}`
            )
            .join("\n");

        const summary = $("#all-codes-message");

        if (summary) {
            summary.innerHTML = `
                <h3>کدهای عضویت اعضای خانواده</h3>
                <div class="all-codes-list">
                    ${membersWithCodes.map(member => `
                        <div>
                            <b>${escapeHTML(member.name)}</b>
                            — ${escapeHTML(member.role)}:
                            <code>${escapeHTML(member.code)}</code>
                        </div>
                    `).join("")}
                </div>
            `;
            summary.hidden = false;
        }

        if (!text) {
            showMessage("کدها دیگر در این صفحه در دسترس نیستند.", "error");
            return;
        }

        try {
            await navigator.clipboard.writeText(text);
            showMessage("کدهای عضویت کپی شدند.", "success");
        } catch {
            showMessage("کدها در صفحه نمایش داده شدند؛ می‌توانی آن‌ها را کپی کنی.");
        }

        return;
    }

    const copyButton = event.target.closest("[data-copy-code]");

    if (copyButton) {
        try {
            await navigator.clipboard.writeText(copyButton.dataset.copyCode);
            showMessage("کد کپی شد.", "success");
        } catch {
            showMessage(`کد عضویت: ${copyButton.dataset.copyCode}`);
        }

        return;
    }

    const pageButton = event.target.closest("[data-page]");

    if (pageButton) {
        renderFamilyPage(pageButton.dataset.page);
        return;
    }

    const editButton = event.target.closest("[data-edit-item]");

    if (editButton) {
        openEditItem(editButton.dataset.editItem);
        return;
    }

    const doneButton = event.target.closest("[data-mark-purchased]");

    if (doneButton) {
        await updateShoppingItem(doneButton.dataset.markPurchased, {
            done: true
        });
        return;
    }

    const restoreButton = event.target.closest("[data-restore-item]");

    if (restoreButton) {
        await updateShoppingItem(restoreButton.dataset.restoreItem, {
            done: false
        });
        return;
    }

    const doneCheckbox = event.target.closest("[data-item-done]");

    if (doneCheckbox) {
        await updateShoppingItem(doneCheckbox.dataset.itemDone, {
            done: doneCheckbox.checked
        });
        return;
    }

    const saveQuantity = event.target.closest("[data-quantity-save]");

    if (saveQuantity) {
        const id = saveQuantity.dataset.quantitySave;
        const input = $(`[data-quantity-input="${id}"]`);
        const quantity = Number(input?.value);

        if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) {
            showMessage("تعداد باید بین ۱ تا ۹۹۹ باشد.", "error");
            return;
        }

        await updateShoppingItem(id, { quantity });
        return;
    }

    const addToShopping = event.target.closest("[data-add-to-shopping]");

    if (addToShopping) {
        await addProductToShopping(addToShopping.dataset.addToShopping);
        return;
    }

    const deleteItem = event.target.closest("[data-delete-item]");

    if (deleteItem) {
        await requestDeleteItem(deleteItem.dataset.deleteItem);
        return;
    }

    const deleteProduct = event.target.closest("[data-delete-product]");

    if (deleteProduct) {
        await requestDeleteProduct(deleteProduct.dataset.deleteProduct);
        return;
    }

    const reviewButton = event.target.closest("[data-review-request]");

    if (reviewButton) {
        await reviewRequest(
            reviewButton.dataset.reviewRequest,
            reviewButton.dataset.approve === "true"
        );
    }
});

/* =========================
   ورود به محیط خانواده
========================= */

async function enterFamily(result) {
    if (result.tabToken) {
        sessionStorage.setItem(TAB_TOKEN_KEY, result.tabToken);
    }

    currentFamilyId = Number(result.family_id);
    currentFamilyName = result.familyName;

    activeFamilyData = {
        ...result,
        member: result.member
            ? normalizeMember(result.member)
            : result.member
    };

    familyMembers = (result.familyMembers || []).map(normalizeMember);

    document.body.classList.add("family-mode");
    showProfileMenus(true);

    updateFamilyHeader();
    setupFamilyNavigation();

    await refreshFamilyData();
    renderFamilyPage("shopping");
    startNotificationUpdates();
    startApprovalNotifications();
}

function updateFamilyHeader() {
    const nameElement = $("#family-page-name");
    const memberElement = $("#family-page-member");

    if (nameElement) {
        nameElement.textContent = currentFamilyName || "خانوادهٔ من";
    }

    if (memberElement) {
        const member = activeFamilyData?.member;

        memberElement.textContent = member
            ? `${member.name} · ${member.username || ""}`
            : "";
    }
}

async function refreshFamilyData() {
    if (!currentFamilyId) return;

    const [productResult, shoppingResult] = await Promise.all([
        familyApi("products"),
        familyApi("shopping-items")
    ]);

    products = productResult.products || [];
    shoppingItems = shoppingResult.items || [];
}

/* =========================
   منوها
========================= */

async function refreshApprovalNotifications() {
    if (!currentFamilyId || !isApprover()) return;

    try {
        const result = await familyApi("requests");

        const requests = result.requests || [];
        const pendingRequests = requests.filter(
            request => request.status === "pending"
        );

        const count = pendingRequests.length;

        // نمایش تعداد درخواست‌های منتظر بررسی روی منو
        $$('[data-page="requests"]').forEach(button => {
            let badge = $(".request-count-badge", button);

            if (count > 0) {
                if (!badge) {
                    badge = document.createElement("span");
                    badge.className = "request-count-badge";
                    button.appendChild(badge);
                }

                badge.textContent = String(count);
                badge.hidden = false;
            } else if (badge) {
                badge.remove();
            }
        });

        // اطلاع از ثبت درخواست جدید
        if (
            lastPendingRequestCount !== null &&
            count > lastPendingRequestCount
        ) {
            showMessage(
                "درخواست جدیدی برای بررسی ثبت شده است.",
                "info"
            );
        }

        lastPendingRequestCount = count;

        // اگر تأییدکننده در صفحه درخواست‌هاست، فهرست را تازه کن
        if (currentPage.startsWith("requests")) {
            await renderRequestsPage(currentPage);
        }
    } catch (err) {
        console.error("خطا در دریافت اعلان درخواست‌ها:", err);
    }
}

function startApprovalNotifications() {
    if (requestRefreshTimer !== null) {
        clearInterval(requestRefreshTimer);
        requestRefreshTimer = null;
    }

    lastPendingRequestCount = null;

    if (!isApprover()) return;

    refreshApprovalNotifications();

    requestRefreshTimer = setInterval(
        refreshApprovalNotifications,
        10000
    );
}

function setupFamilyNavigation() {
    const sidebar = $(".family-sidebar");
    const bottomNav = $(".family-bottom-nav");

    if (!sidebar || !bottomNav) return;

    $$(".generated-nav", sidebar).forEach(element => element.remove());
    $$(".generated-nav", bottomNav).forEach(element => element.remove());

    const requestLabel = isApprover() ? "درخواست‌ها" : "درخواست‌های من";
    const requestPage = isApprover() ? "requests" : "my-requests";

    $$('[data-page="requests"]', document).forEach(button => {
        button.dataset.page = requestPage;

        const label = button.querySelector("span");

        if (label) {
            label.textContent = requestLabel;
        } else if (button.closest(".family-sidebar")) {
            button.textContent = `✓ ${requestLabel}`;
        } else {
            button.innerHTML = `✓<span>${requestLabel}</span>`;
        }
    });

    const purchasedSidebar = document.createElement("button");
    purchasedSidebar.type = "button";
    purchasedSidebar.className = "family-nav generated-nav";
    purchasedSidebar.dataset.page = "purchased";
    purchasedSidebar.textContent = "🛍 کالاهای خریداری‌شده";

    const sidebarShopping = $('[data-page="shopping"]', sidebar);
    if (sidebarShopping) {
        sidebarShopping.insertAdjacentElement("afterend", purchasedSidebar);
    }

    const purchasedBottom = document.createElement("button");
    purchasedBottom.type = "button";
    purchasedBottom.className = "family-nav generated-nav";
    purchasedBottom.dataset.page = "purchased";
    purchasedBottom.innerHTML = "🛍<span>خریداری‌شده</span>";

    const bottomShopping = $('[data-page="shopping"]', bottomNav);
    if (bottomShopping) {
        bottomShopping.insertAdjacentElement("afterend", purchasedBottom);
    }

    if (isApprover()) {
        const requestsButton = $('[data-page="requests"]', sidebar);

        if (requestsButton) {
            const submenu = document.createElement("div");
            submenu.className = "approver-subnav generated-nav";

            submenu.innerHTML = `
                <button class="family-nav" data-page="requests-add">
                    در انتظار تأیید برای افزودن
                </button>
                <button class="family-nav" data-page="requests-delete">
                    در انتظار تأیید برای حذف
                </button>
                <button class="family-nav" data-page="requests-edit">
                    در انتظار تأیید برای ویرایش
                </button>
            `;

            requestsButton.insertAdjacentElement("afterend", submenu);
        }
    }
}

/* =========================
   جابه‌جایی صفحات
========================= */

function renderFamilyPage(page) {
    currentPage = page;

    $$(".family-nav").forEach(button => {
        const buttonPage = button.dataset.page;

        button.classList.toggle(
            "active",
            buttonPage === page ||
            (
                page.startsWith("requests") &&
                isApprover() &&
                buttonPage === "requests"
            ) ||
            (
                page === "my-requests" &&
                buttonPage === "my-requests"
            )
        );
    });

    const content = $("#family-page-content");
    if (!content) return;

    if (page === "shopping") {
        renderShoppingPage(content, false);
    } else if (page === "purchased") {
        renderShoppingPage(content, true);
    } else if (page === "products") {
        renderProductPage(content);
    } else if (page === "members") {
        renderMembersPage(content);
    } else if (page === "my-requests") {
        renderMyRequestsPage();
    } else if (page.startsWith("requests")) {
        renderRequestsPage(page);
    } else if (page === "exit") {
        document.body.classList.remove("family-mode");
        showProfileMenus(false);
        closeModal();
    }
}

/* =========================
   فهرست خرید و خریداری‌شده‌ها
========================= */

function renderShoppingPage(content, purchased = false) {
    const visibleItems = shoppingItems.filter(item =>
        Boolean(item.done) === purchased
    );

    const rows = visibleItems.map(item => `
        <article class="shopping-row ${item.done ? "is-done" : ""}">
            <div class="shopping-item-main">
                <h3 class="shopping-item-title">
                    ${escapeHTML(item.name)}
                </h3>

                ${
                    item.description
                        ? `<p class="shopping-item-description">
                            ${escapeHTML(item.description)}
                           </p>`
                        : ""
                }

            </div>

            <div class="shopping-item-actions">
                ${
                    purchased
                        ? `<button
                            class="small-button success"
                            data-restore-item="${item.id}">
                            بازگرداندن
                           </button>`
                        : `
                            <button
                                class="small-button edit"
                                data-edit-item="${item.id}">
                                ویرایش
                            </button>

                            <button
                                class="small-button success"
                                data-mark-purchased="${item.id}">
                                خریدم
                            </button>

                            <button
                                class="small-button danger"
                                data-delete-item="${item.id}">
                                حذف
                            </button>
                        `
                }
            </div>
        </article>
    `).join("");

    content.innerHTML = `
        <div class="page-heading">
            <div>
                <span class="eyebrow">خریدهای خانواده</span>
                <h1>${purchased ? "کالاهای خریداری‌شده" : "فهرست خرید"}</h1>
                <p>
                    ${
                        purchased
                            ? "کالاهایی که خریداری شده‌اند در این بخش هستند."
                            : "برای افزودن کالا، از بخش «افزودن کالا» استفاده کن."
                    }
                </p>
            </div>
        </div>

        <section class="family-content-card">
            <h2>${purchased ? "خریدهای انجام‌شده" : "موارد فهرست"}</h2>

            ${
                rows
                    ? `<div class="shopping-list">${rows}</div>`
                    : `<p class="empty-state">
                        ${purchased
                            ? "هنوز کالایی به بخش خریداری‌شده‌ها منتقل نشده است."
                            : "فهرست خرید خالی است."}
                       </p>`
            }
        </section>
    `;
}
function openEditItem(itemId) {
    const item = shoppingItems.find(
        entry => Number(entry.id) === Number(itemId)
    );

    if (!item) {
        showMessage("این کالا در فهرست پیدا نشد.", "error");
        return;
    }

    showModal(`
        <h2 id="modal-title">ویرایش کالا</h2>

        <p class="modal-description">
            ${
                isApprover()
                    ? "تغییرات پس از ذخیره اعمال می‌شوند."
                    : "تغییرات به‌صورت درخواست برای تأیید ارسال می‌شوند."
            }
        </p>

        <form id="edit-item-form"
              class="form-stack"
              data-item-id="${item.id}">
            <label>
                عنوان کالا
                <input name="name"
                       maxlength="80"
                       value="${escapeHTML(item.name)}"
                       required>
            </label>

            <label>
                توضیحات
                <textarea name="description"
                          maxlength="500"
                          rows="4">${escapeHTML(item.description || "")}</textarea>
            </label>

            <button class="button primary" type="submit">
                ${isApprover() ? "ذخیرهٔ تغییرات" : "ارسال درخواست ویرایش"}
            </button>
        </form>
    `);
}

async function updateShoppingItem(itemId, changes) {
    try {
        const result = await familyApi(
            `shopping-items/${itemId}`,
            jsonOptions("PATCH", changes)
        );

        showMessage(result.message || "مورد به‌روزرسانی شد.", "success");

        await refreshFamilyData();
        renderFamilyPage(currentPage);
    } catch (err) {
        showMessage(err.message, "error");
    }
}

async function requestDeleteItem(itemId) {
    const approved = await confirmInSite(
        "آیا درخواست حذف این مورد ثبت شود؟",
        "تأیید حذف کالا"
    );

    if (!approved) return;

    try {
        const result = await familyApi(
            `shopping-items/${itemId}`,
            { method: "DELETE" }
        );

        showMessage(
            result.message || "درخواست حذف ثبت شد.",
            "success"
        );

        await refreshFamilyData();
        renderFamilyPage(currentPage);
    } catch (err) {
        showMessage(err.message, "error");
    }
}/* =========================
   فهرست کالاها
========================= */

function renderProductPage(content) {
    content.innerHTML = `
        <div class="page-heading">
            <div>
                <span class="eyebrow">مدیریت کالاها</span>
                <h1>افزودن کالا</h1>
                <p>
                    مشخصات کالای جدید را وارد کن.
                </p>
            </div>
        </div>

        <section class="family-content-card">
            <h2>ثبت کالای جدید</h2>

            <form id="product-form" class="form-stack">
                <label>
                    نام کالا
                    <input
                        name="name"
                        maxlength="80"
                        placeholder="مثلاً نان سنگک"
                        required
                    >
                </label>

                <label>
                    توضیح محصول
                    <textarea
                        name="description"
                        maxlength="500"
                        rows="3"
                        placeholder="توضیحات مربوط به کالا را بنویس..."
                        required
                    ></textarea>
                </label>

                <button class="button primary" type="submit">
                    ثبت کالا
                </button>
            </form>

            ${
                !isApprover()
                    ? `<p class="modal-description">
                        کالای جدید پس از تأیید مسئول خانواده ثبت می‌شود.
                       </p>`
                    : ""
            }
        </section>
    `;
}async function addProductToShopping(productId) {
    const product = products.find(
        item => Number(item.id) === Number(productId)
    );

    if (!product) {
        showMessage("کالای انتخاب‌شده پیدا نشد.", "error");
        return;
    }

    try {
        const result = await familyApi(
            "shopping-items",
            jsonOptions("POST", {
                productId: Number(productId),
                quantity: 1
            })
        );

        showMessage(
            result.message || "درخواست افزودن به فهرست ثبت شد.",
            "success"
        );

        await refreshFamilyData();
        renderFamilyPage("products");
    } catch (err) {
        showMessage(err.message, "error");
    }
}
/* =========================
   اعضای خانواده
========================= */

function renderMembersPage(content) {
    content.innerHTML = `
        <div class="page-heading">
            <div>
                <span class="eyebrow">اعضای خانواده</span>
                <h1>اعضای خانواده</h1>
            </div>
        </div>

        <section class="member-grid">
            ${familyMembers.map(member => `
                <article class="member-card">
                    <div class="member-avatar">
                        ${escapeHTML((member.name || "?").slice(0, 1))}
                    </div>

                    <h3>${escapeHTML(member.name)}</h3>
                    <p>${escapeHTML(roleLabel(member.role))}</p>

                    <div class="member-badges">
                        ${
                            member.isApprover
                                ? `<span class="pill">تأییدکننده</span>`
                                : ""
                        }

                        ${
                            Number(member.id) === currentMemberId()
                                ? `<span class="pill active-pill">حساب شما</span>`
                                : ""
                        }
                    </div>

                    <small>
                        ${
                            member.username
                                ? `نام کاربری: ${escapeHTML(member.username)}`
                                : "حساب هنوز فعال نشده است"
                        }
                    </small>
                </article>
            `).join("")}
        </section>
    `;
}

/* =========================
   درخواست‌های در انتظار تأیید
========================= */

async function renderRequestsPage(page = "requests") {
    const content = $("#family-page-content");

if (page === "requests-add") {
    viewedRequestSections.add("add");
} else if (page === "requests-delete") {
    viewedRequestSections.add("delete");
} else if (page === "requests-edit") {
    viewedRequestSections.add("edit");
} else if (page === "requests") {
    viewedRequestSections.clear();
}

await refreshNotificationBadges();

    if (!isApprover()) {
        content.innerHTML = `
            <section class="family-content-card">
                <h2>درخواست‌ها</h2>
                <p class="empty-state">
                    این بخش مخصوص تأییدکننده‌های خانواده است.
                </p>
            </section>
        `;
        return;
    }

    const thisRender = ++pageRenderId;

    content.innerHTML = `
        <section class="family-content-card">
            <h2>درخواست‌های در انتظار</h2>
            <p class="empty-state">در حال دریافت درخواست‌ها…</p>
        </section>
    `;

    try {
        const result = await familyApi("requests");

        if (thisRender !== pageRenderId) return;

        let requests = result.requests || [];

        if (page === "requests-add") {
            requests = requests.filter(request =>
                ["add_product", "add_item"].includes(request.request_type)
            );
        } else if (page === "requests-delete") {
            requests = requests.filter(request =>
                ["delete_item", "delete_product"].includes(request.request_type)
            );
        } else if (page === "requests-edit") {
            requests = requests.filter(request =>
                request.request_type === "edit_item"
            );
        }

        const rows = requests.map(request => `
            <article class="request-row">
                <div class="request-row-info">
                    <h3>${escapeHTML(request.name)}</h3>

                    <p>${escapeHTML(requestTypeLabel(request.request_type))}</p>

                    <small>
                        درخواست‌دهنده:
                        ${escapeHTML(request.requester_name || "عضو خانواده")}
                        · ${escapeHTML(roleLabel(request.requester_role))}
                    </small>

                    ${
                        request.request_type === "edit_item"
                            ? `
                                <div class="request-change-details">
                                    <p>
                                        <b>عنوان قبلی:</b>
                                        ${escapeHTML(request.old_name)}
                                    </p>
                                    <p>
                                        <b>عنوان جدید:</b>
                                        ${escapeHTML(request.name)}
                                    </p>
                                    <p>
                                        <b>توضیح قبلی:</b>
                                        ${escapeHTML(request.old_description)}
                                    </p>
                                    <p>
                                        <b>توضیح جدید:</b>
                                        ${escapeHTML(request.description)}
                                    </p>
                                </div>
                            `
                            : request.description
                                ? `<p>${escapeHTML(request.description)}</p>`
                                : ""
                    }
                </div>

                <div class="request-actions">
                    <button
                        type="button"
                        class="small-button success"
                        data-review-request="${request.id}"
                        data-approve="true">
                        تأیید
                    </button>

                    <button
                        type="button"
                        class="small-button danger"
                        data-review-request="${request.id}"
                        data-approve="false">
                        رد
                    </button>
                </div>
            </article>
        `).join("");

        const title = {
            requests: "درخواست‌های در انتظار",
            "requests-add": "در انتظار تأیید برای افزودن",
            "requests-delete": "در انتظار تأیید برای حذف",
            "requests-edit": "در انتظار تأیید برای ویرایش"
        }[page] || "درخواست‌های در انتظار";

        content.innerHTML = `
            <div class="page-heading">
                <div>
                    <span class="eyebrow">مدیریت خانواده</span>
                    <h1>${title}</h1>
                </div>
            </div>

            <section class="family-content-card">
                ${
                    rows
                        ? `<div class="request-list">${rows}</div>`
                        : `<p class="empty-state">
                            درخواستی در این بخش وجود ندارد.
                           </p>`
                }
            </section>
        `;
    } catch (err) {
        if (thisRender !== pageRenderId) return;

        content.innerHTML = `
            <section class="family-content-card">
                <p class="empty-state">${escapeHTML(err.message)}</p>
            </section>
        `;
    }
}

async function reviewRequest(requestId, approve) {
    console.log("تابع reviewRequest اجرا شد:", requestId, approve);
  try {
        const result = await familyApi(
            `requests/${requestId}/review`,
            jsonOptions("POST", { approve })
        );

        console.log("نتیجه تأیید درخواست:", result);

        await refreshFamilyData();

        const shoppingResult = await familyApi("shopping-items");

        console.log("نتیجه دریافت فهرست خرید:", shoppingResult);
        console.log("شناسه خانواده فعلی:", currentFamilyId);
        console.log("کالاهای دریافت‌شده:", shoppingItems);

        await renderRequestsPage(currentPage);
        await refreshNotificationBadges();
        showMessage(
            result.message || "درخواست بررسی شد.",
            "success"
        );
    } catch (err) {
        console.error("خطا در تأیید درخواست:", err);
        showMessage(err.message, "error");
    }
}
/* =========================
   درخواست‌های من
========================= */

async function renderMyRequestsPage() {
    const content = $("#family-page-content");
  clearNotificationBadge('[data-page="my-requests"]');
    content.innerHTML = `
        <div class="page-heading">
            <div>
                <span class="eyebrow">پیگیری درخواست‌ها</span>
                <h1>درخواست‌های من</h1>
            </div>
        </div>

        <section class="family-content-card">
            <p class="empty-state">در حال دریافت درخواست‌ها…</p>
        </section>
    `;

    try {
        const result = await familyApi("my-requests");
        myRequests = result.requests || [];

        const rows = myRequests.map(request => `
            <article class="request-row">
                <div class="request-row-info">
                    <h3>${escapeHTML(request.name)}</h3>

                    <p>${escapeHTML(requestTypeLabel(request.request_type))}</p>

                    ${
                        request.description
                            ? `<p>${escapeHTML(request.description)}</p>`
                            : ""
                    }

                    ${
                        request.request_type === "edit_item"
                            ? `
                                <div class="request-change-details">
                                    <p>
                                        <b>عنوان قبلی:</b>
                                        ${escapeHTML(request.old_name)}
                                    </p>
                                    <p>
                                        <b>عنوان پیشنهادی:</b>
                                        ${escapeHTML(request.name)}
                                    </p>
                                </div>
                            `
                            : ""
                    }

                    ${
                        request.reviewer_name
                            ? `<small>
                                بررسی‌کننده:
                                ${escapeHTML(request.reviewer_name)}
                               </small>`
                            : ""
                    }
                </div>

                <span class="request-status ${requestStatusClass(request.status)}">
                    ${escapeHTML(requestStatusLabel(request.status))}
                </span>
            </article>
        `).join("");

        content.innerHTML = `
            <div class="page-heading">
                <div>
                    <span class="eyebrow">پیگیری درخواست‌ها</span>
                    <h1>درخواست‌های من</h1>
                    <p>وضعیت درخواست‌های ارسال‌شده را از اینجا بررسی کن.</p>
                </div>
            </div>

            <section class="family-content-card">
                ${
                    rows
                        ? `<div class="request-list">${rows}</div>`
                        : `<p class="empty-state">
                            هنوز درخواستی ارسال نکرده‌ای.
                           </p>`
                }
            </section>
        `;
    } catch (err) {
        content.innerHTML = `
            <section class="family-content-card">
                <p class="empty-state">${escapeHTML(err.message)}</p>
            </section>
        `;
    }
}

/* =========================
   تنظیمات حساب
========================= */

function openSettings() {
    if (!activeFamilyData?.member) return;

    const member = activeFamilyData.member;

    showModal(`
        <h2 id="modal-title">تنظیمات کاربر</h2>

        <p class="modal-description">
            در این بخش نام کاربری را تغییر می‌دهی.
        </p>

        <form id="settings-form" class="form-stack">
            <label>
                نام کاربری
                <input name="username"
                       value="${escapeHTML(member.username || "")}"
                       pattern="[A-Za-z0-9_.-]{3,24}"
                       minlength="3" maxlength="24" required>
            </label>

            <button class="button primary" type="submit">
                ذخیرهٔ نام کاربری
            </button>
        </form>
    `);
}

function openChangePassword() {
    if (!activeFamilyData?.member) return;

    showModal(`
        <h2 id="modal-title">تغییر رمز عبور</h2>

        <p class="modal-description">
            رمز جدید باید حداقل ۸ نویسه داشته باشد.
        </p>

        <form id="change-password-form" class="form-stack">
            <label>
                رمز عبور جدید
                <input name="password" type="password"
                       minlength="8" maxlength="128" required>
            </label>

            <label>
                تکرار رمز عبور جدید
                <input name="confirmPassword" type="password"
                       minlength="8" maxlength="128" required>
            </label>

            <button class="button primary" type="submit">
                تأیید و تغییر رمز
            </button>
        </form>
    `);
}

/* =========================
   خروج از حساب
========================= */

async function logout() {
  stopNotificationUpdates();
    if (requestRefreshTimer !== null) {
    clearInterval(requestRefreshTimer);
    requestRefreshTimer = null;
}

lastPendingRequestCount = null;
  try {
        await apiRequest(
            "/api/logout",
            jsonOptions("POST", {})
        );
    } catch (err) {
        showMessage(err.message, "error");
    }

    sessionStorage.removeItem(TAB_TOKEN_KEY);

    currentFamilyId = null;
    currentFamilyName = "";
    activeFamilyData = null;
    familyMembers = [];
    products = [];
    shoppingItems = [];
    myRequests = [];

    document.body.classList.remove("family-mode");

    showProfileMenus(false);
    closeModal();

    showMessage("از حساب خارج شدی.", "success");
}

/* =========================
   بازیابی ورود همین تب
========================= */

document.addEventListener("DOMContentLoaded", async () => {
    showProfileMenus(false);

    if (!sessionStorage.getItem(TAB_TOKEN_KEY)) {
        document.body.classList.remove("family-mode");
        return;
    }

    try {
        const result = await apiRequest("/api/account");
        await enterFamily(result);
    } catch {
        sessionStorage.removeItem(TAB_TOKEN_KEY);

        currentFamilyId = null;
        currentFamilyName = "";
        activeFamilyData = null;
        familyMembers = [];
        products = [];
        shoppingItems = [];
        myRequests = [];

        document.body.classList.remove("family-mode");
        showProfileMenus(false);
    }
});