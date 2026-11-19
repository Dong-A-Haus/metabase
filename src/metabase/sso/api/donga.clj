(ns metabase.sso.api.donga
  "GET /auth/donga: Đông A OS signs a person in to Metabase (Đông A's change to Metabase: DONGA.md at the repo root).

  Only Đông A OS's door reaches this with the person's identity: it drops any X-Donga-* header a browser sent, asks
  the OS's gate who is signed in (refusing anyone the OS refuses), copies the gate's X-Donga-* identity headers onto
  the request and adds X-Donga-Door, the secret it shares with Metabase (env MB_DONGA_DOOR_SECRET). So this route:

  - is not there (404) while MB_DONGA_DOOR_SECRET is unset, or shorter than 32 characters;
  - refuses (403) any request whose X-Donga-Door is not that secret, compared in constant time;
  - refuses (400) a landing place that could leave this origin;
  - otherwise signs in the person the headers name ([[metabase.sso.providers.donga]]), sets Metabase's session
    cookies exactly as its own password login does, and redirects to `?redirect=` (or X-Donga-Redirect, which the
    door sets for a page asked for with no live session), a path on this origin.

  Nothing is shown in between: no Metabase login page, no extra step."
  (:require
   [clojure.string :as str]
   [java-time.api :as t]
   [metabase.api.macros :as api.macros]
   [metabase.auth-identity.core :as auth-identity]
   [metabase.config.core :as config]
   [metabase.request.core :as request]
   [metabase.sso.providers.donga]
   [metabase.util.log :as log]
   [ring.util.response :as response])
  (:import
   (java.nio.charset StandardCharsets)
   (java.security MessageDigest)))

(set! *warn-on-reflection* true)

(def min-secret-length
  "The shortest MB_DONGA_DOOR_SECRET this route trusts (setup.sh makes 64 hex characters)."
  32)

(defn- door-secret
  "MB_DONGA_DOOR_SECRET, or nil when it is unset or too short to trust."
  []
  (let [s (config/config-str :mb-donga-door-secret)]
    (when (and (string? s) (>= (count s) min-secret-length))
      s)))

(defn- sha256 ^bytes [^String s]
  (.digest (MessageDigest/getInstance "SHA-256") (.getBytes s StandardCharsets/UTF_8)))

(defn- door-matches?
  "Whether `presented` is the door's `secret`: compared as SHA-256 digests in constant time, so neither the secret's
  contents nor its length show in the timing."
  [^String secret presented]
  (and (string? presented)
       (MessageDigest/isEqual (sha256 secret) (sha256 presented))))

(defn safe-redirect
  "The path on this origin to land on for `raw`: \"/\" when it is absent or one of Metabase's own sign-in pages (they
  would come straight back here), `raw` when it is a plain path, nil (refused) for anything that could leave this
  origin: a scheme, `//host`, `/\\host`, a control character or a backslash."
  [raw]
  (cond
    (or (nil? raw) (str/blank? raw))                  "/"
    (or (not (str/starts-with? raw "/"))
        (str/starts-with? raw "//")
        (> (count raw) 2048)
        (re-find #"[\x00-\x1f\x7f\\]" raw))           nil
    (re-find #"(?i)^/auth(/|\?|#|$)" raw)              "/"
    :else                                             raw))

(defn- plain
  [status text]
  {:status  status
   :headers {"Content-Type" "text/plain; charset=utf-8", "Cache-Control" "no-store"}
   :body    text})

(defn- sign-in
  [request target]
  (let [result (auth-identity/login! :provider/donga (assoc request :device-info (request/device-info request)))]
    (if-let [session (when (true? (:success? result)) (:session result))]
      (do
        (log/infof "Đông A OS signed in Metabase user %d" (:id (:user result)))
        (request/set-session-cookies request
                                     (assoc-in (response/redirect target) [:headers "Cache-Control"] "no-store")
                                     session
                                     (t/zoned-date-time (t/zone-id "GMT"))))
      (do
        (log/warnf "Đông A OS sign-in refused: %s" (:error result))
        (plain (if (= :invalid-request (:error result)) 400 403)
               (str (or (:message result) "Đông A OS sign-in failed.")))))))

#_{:clj-kondo/ignore [:metabase/validate-defendpoint-has-response-schema]}
(api.macros/defendpoint :get "/"
  "Sign in the person Đông A OS's door vouches for, then go to `redirect` (a path on this origin)."
  [_route-params
   {:keys [redirect]} :- [:map [:redirect {:optional true} [:maybe :string]]]
   _body
   request]
  (let [secret (door-secret)
        header #(get-in request [:headers %])]
    (cond
      (nil? secret)
      (plain 404 "Not found.")

      (not (door-matches? secret (header "x-donga-door")))
      (plain 403 "Sign in through Đông A OS.")

      :else
      (if-let [target (safe-redirect (or (header "x-donga-redirect") redirect))]
        (sign-in request target)
        (plain 400 "That page is not on this site.")))))

(def ^{:arglists '([request respond raise])} routes
  "`/auth/donga` routes."
  (api.macros/ns-handler *ns*))
