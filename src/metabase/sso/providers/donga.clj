(ns metabase.sso.providers.donga
  "Đông A OS as an identity provider (Đông A's change to Metabase: DONGA.md at the repo root).

  The OS's door (Caddy in front of Metabase) asks the OS who is signed in and sends that person's identity on the
  request as X-Donga-* headers, each value percent-encoded as UTF-8 (JavaScript's `encodeURIComponent`):

    X-Donga-User   the OS login (stable; kept as the AuthIdentity's provider_id)
    X-Donga-Email  the person's email for the tools
    X-Donga-Name   the name people see (optional; the login when absent)
    X-Donga-Roles  the person's OS roles, each encoded, joined by \",\" (optional)

  [[metabase.sso.api.donga]] trusts these headers only on a request that also carries the door's secret. This
  provider finds or creates that Metabase user, marked as from Đông A OS (`sso_source` \"donga\" and an AuthIdentity
  with provider \"donga\"), then makes their groups follow their OS roles on every sign-in: OS role CEO is Metabase's
  Administrators group (so admin), every other role is the Metabase group named after it (created when missing), and
  a role the OS took away is gone at the next sign-in. A Metabase account that was not made by the OS (the
  break-glass admin, any password user) is never signed in this way."
  (:require
   [clojure.string :as str]
   [metabase.auth-identity.core :as auth-identity]
   [metabase.permissions.core :as perms]
   [metabase.sso.common :as sso.common]
   [metabase.sso.db :as sso.db]
   [metabase.util :as u]
   [metabase.util.log :as log]
   [methodical.core :as methodical]
   [ring.util.codec :as codec]))

(set! *warn-on-reflection* true)

(def provider-name
  "The AuthIdentity provider and `core_user.sso_source` of people Đông A OS signs in."
  "donga")

(def admin-role
  "The OS role that is Metabase's admin."
  "CEO")

(auth-identity/derive! :provider/donga :metabase.auth-identity.provider/provider)
(auth-identity/derive! :provider/donga :metabase.auth-identity.provider/create-user-if-not-exists)

;;; -------------------------------------------------- The headers --------------------------------------------------

(defn- decode
  "One percent-encoded (UTF-8) header value, trimmed; nil when it is missing, blank, longer than `max-length` or holds
  a control character."
  [s max-length]
  (when (string? s)
    (let [v (str/trim (codec/url-decode s))]
      (when (and (<= 1 (count v) max-length)
                 (not (re-find #"[\x00-\x1f\x7f]" v)))
        v))))

(def ^:private role-pattern
  "An OS role code (CEO, SALES, MARKETING ...): also the name of its Metabase group."
  #"[A-Za-z0-9_.-]{1,64}")

(defn- decode-roles
  [s]
  (when (string? s)
    (into []
          (comp (map #(decode % 64))
                (filter #(and % (re-matches role-pattern %)))
                (distinct))
          (str/split s #","))))

(defn person
  "The person the door vouches for, from the X-Donga-* headers of a Ring `request`, as
  `{:login :email :name :roles}`; nil when the login or a valid email is missing. Only call this once the door's
  secret has been checked."
  [{:keys [headers] :as _request}]
  (let [login (decode (get headers "x-donga-user") 254)
        email (some-> (decode (get headers "x-donga-email") 254) u/lower-case-en)]
    (when (and login email (u/email? email))
      {:login login
       :email email
       :name  (or (decode (get headers "x-donga-name") 254) login)
       :roles (or (decode-roles (get headers "x-donga-roles")) [])})))

;;; -------------------------------------------------- Roles -> groups --------------------------------------------------

(defn- role-group
  "The Metabase group for OS role `role`, created when missing; nil for a name that is one of Metabase's own groups
  (Administrators, All Users ...) or a tenant group, which a role never stands for."
  [role]
  (let [group (or (sso.db/group-by-name role)
                  (try
                    (sso.db/insert-group! role)
                    (catch Exception e
                      ;; another sign-in made it first
                      (or (sso.db/group-by-name role) (throw e)))))]
    (if (or (:magic_group_type group) (:is_tenant_group group))
      (log/warnf "Đông A OS role %s names one of Metabase's own groups; it is not mapped" (pr-str role))
      group)))

(defn- sync-roles!
  "Make `user`'s groups the ones their OS `roles` stand for. Returns nil when that held, else the failed login result
  (an admin that could not be revoked, e.g. the last one, must not get a session)."
  [user roles]
  (let [admin?   (boolean (some #{admin-role} roles))
        admin-id (u/the-id (perms/admin-group))
        groups   (cond-> (into [] (keep role-group) (remove #{admin-role} roles))
                   admin? (conj admin-id))]
    (sso.common/sync-group-memberships! user groups)
    (when-not (= admin? (sso.db/user-in-group? (u/the-id user) admin-id))
      (log/errorf "Đông A OS: Metabase user %d should %s admin, and is not; refusing the sign-in"
                  (u/the-id user) (if admin? "be" "not be"))
      {:success? false
       :error    :roles-not-applied
       :message  "Your Đông A OS roles could not be applied in Metabase. Ask Metabase's admin."})))

;;; -------------------------------------------------- The provider --------------------------------------------------

(methodical/defmethod auth-identity/authenticate :provider/donga
  [_provider request]
  (if-let [{:keys [login email name roles]} (person request)]
    {:success?    true
     :user-data   {:email      email
                   :first_name name
                   :last_name  nil
                   :sso_source (keyword provider-name)
                   :groups     roles}
     :provider-id login}
    {:success? false
     :error    :invalid-request
     :message  "Đông A OS did not say who is signed in."}))

(methodical/defmethod auth-identity/login! :provider/donga
  [provider request]
  (cond
    (not (true? (:success? request)))
    request

    ;; An account Metabase made some other way (its break-glass admin, a password user) is not the OS's to take over.
    (and (:user request)
         (not (sso.db/auth-identity-exists? (u/the-id (:user request)) provider-name)))
    {:success? false
     :error    :not-from-donga
     :message  "This email belongs to a Metabase account that Đông A OS did not make."}

    :else
    (let [result (next-method provider request)
          user   (:user result)]
      (or (when (and (true? (:success? result)) user (:is_active user))
            (sync-roles! user (get-in request [:user-data :groups])))
          result))))
