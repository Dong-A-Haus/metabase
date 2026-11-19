(ns metabase.sso.api.donga-test
  "GET /auth/donga (DONGA.md): Đông A OS's door signs a person in, never anyone else."
  (:require
   [clojure.string :as str]
   [clojure.test :refer :all]
   [metabase.permissions.core :as perms]
   [metabase.sso.api.donga :as donga.api]
   [metabase.test :as mt]
   [metabase.test.fixtures :as fixtures]
   [metabase.test.http-client :as client]
   [metabase.util :as u]
   [toucan2.core :as t2])
  (:import
   (java.net URLEncoder)))

(set! *warn-on-reflection* true)

(use-fixtures :once (fixtures/initialize :db :web-server :test-users))

(def ^:private secret "0d0e3b9c5a7f41e2b8c6d4f2a1e9c7b5d3f1a8e6c4b2d0f9e7c5a3b1d9f7e5c3")

(defn- enc
  "JavaScript's encodeURIComponent, as the OS's gate writes each header value."
  [^String s]
  (-> (URLEncoder/encode s "UTF-8") (str/replace "+" "%20")))

(defn- person-headers
  [{:keys [login email name roles]}]
  (cond-> {"X-Donga-User" (enc login), "X-Donga-Email" (enc email)}
    name  (assoc "X-Donga-Name" (enc name))
    roles (assoc "X-Donga-Roles" (str/join "," (map enc roles)))))

(defn- door
  "GET /auth/donga with `headers`, as the door (or anyone else) sends it; the raw response, redirects not followed."
  [expected-status headers & query]
  (binding [client/*url-prefix* ""]
    (apply mt/client-real-response :get expected-status "/auth/donga"
           {:request-options {:redirect-strategy :none, :headers headers}}
           query)))

(defn- session-key
  "The metabase.SESSION cookie the response set, if any (clj-http parses Set-Cookie into :cookies)."
  [resp]
  (get-in resp [:cookies "metabase.SESSION" :value]))

(defn- current-user [resp]
  (binding [client/*url-prefix* ""]
    (mt/client (session-key resp) :get 200 "/api/user/current")))

(defn- group-names [user-id]
  (t2/select-fn-set :name :model/PermissionsGroup
                    :id [:in (t2/select-fn-set :group_id :model/PermissionsGroupMembership :user_id user-id)]))

(defn- fresh-person []
  (let [n (str (rand-int 100000000))]
    {:login (str "tuan.nguyen" n)
     :email (str "tuan.nguyen" n "@donga.test")
     :name  "Nguyễn Văn Tuấn"}))

(defmacro ^:private with-door [& body]
  `(mt/with-temp-env-var-value! [~'mb-donga-door-secret secret]
     (mt/with-model-cleanup [:model/User :model/PermissionsGroup]
       ~@body)))

(deftest off-without-secret-test
  (let [who (fresh-person)]
    (testing "no MB_DONGA_DOOR_SECRET: the route is not there"
      (mt/with-temp-env-var-value! [mb-donga-door-secret nil]
        (let [resp (door 404 (assoc (person-headers who) "X-Donga-Door" secret))]
          (is (nil? (session-key resp))))))
    (testing "a secret too short to trust counts as none"
      (mt/with-temp-env-var-value! [mb-donga-door-secret "short-secret"]
        (is (nil? (session-key (door 404 (assoc (person-headers who) "X-Donga-Door" "short-secret")))))))
    (is (not (t2/exists? :model/User :%lower.email (:email who))))))

(deftest refused-without-the-door-test
  (with-door
    (let [who (assoc (fresh-person) :roles ["CEO"])]
      (doseq [[label headers] {"no X-Donga-Door"   (person-headers who)
                               "a wrong secret"    (assoc (person-headers who) "X-Donga-Door" (str secret "x"))
                               "the secret's case" (assoc (person-headers who) "X-Donga-Door" (u/upper-case-en secret))
                               "an empty secret"   (assoc (person-headers who) "X-Donga-Door" "")}]
        (testing label
          (let [resp (door 403 headers :redirect "/question/1")]
            (is (nil? (session-key resp)))
            (is (nil? (get-in resp [:headers "Location"]))))))
      (is (not (t2/exists? :model/User :%lower.email (:email who)))))))

(deftest ceo-is-admin-test
  (with-door
    (let [who  (assoc (fresh-person) :roles ["CEO"])
          resp (door 302 (assoc (person-headers who) "X-Donga-Door" secret) :redirect "/question/7?a=1")]
      (testing "lands on the page asked for, with Metabase's own session cookie"
        (is (= "/question/7?a=1" (get-in resp [:headers "Location"])))
        (is (string? (session-key resp)))
        (is (contains? (:cookies resp) "metabase.TIMEOUT")))
      (testing "the session is that person, an admin, marked as from Đông A OS"
        (let [me (current-user resp)]
          (is (= (:email who) (:email me)))
          (is (= "Nguyễn Văn Tuấn" (:common_name me)))
          (is (true? (:is_superuser me))))
        (let [user (t2/select-one :model/User :%lower.email (:email who))]
          (is (= :donga (:sso_source user)))
          (is (= {:provider "donga" :provider_id (:login who)}
                 (t2/select-one [:model/AuthIdentity :provider :provider_id] :user_id (:id user) :provider "donga")))
          (is (contains? (group-names (:id user)) (:name (perms/admin-group)))))))))

(deftest roles-follow-the-os-test
  (with-door
    (let [n     (rand-int 100000000)
          sales (str "SALES" n)
          mkt   (str "MARKETING" n)
          who   (fresh-person)
          as    (fn [roles] (door 302 (assoc (person-headers (assoc who :roles roles)) "X-Donga-Door" secret)))
          user  #(t2/select-one :model/User :%lower.email (:email who))]
      (as ["CEO"])
      (is (true? (:is_superuser (user))))
      (testing "moved out of CEO into a sales role: no longer admin, in the group named after the role (made now)"
        (let [me (current-user (as [sales]))]
          (is (false? (:is_superuser me))))
        (is (false? (:is_superuser (user))))
        (is (= #{"All Users" sales} (group-names (:id (user))))))
      (testing "two roles, two groups; then a role taken away is gone at the next sign-in"
        (as [sales mkt])
        (is (= #{"All Users" sales mkt} (group-names (:id (user)))))
        (as [mkt])
        (is (= #{"All Users" mkt} (group-names (:id (user))))))
      (testing "a role never stands for one of Metabase's own groups"
        (as ["Administrators" "all users"])
        (is (false? (:is_superuser (user))))
        (is (= #{"All Users"} (group-names (:id (user))))))
      (testing "one person is one Metabase user however often they come"
        (is (= 1 (t2/count :model/User :%lower.email (:email who))))))))

(deftest only-this-origin-test
  (with-door
    (let [who     (assoc (fresh-person) :roles ["CEO"])
          headers (assoc (person-headers who) "X-Donga-Door" secret)]
      (doseq [bad ["https://evil.test/x" "//evil.test/x" "/\\evil.test" "javascript:alert(1)" "evil.test"
                   "/a\r\nLocation: https://evil.test"]]
        (testing (pr-str bad)
          (let [resp (door 400 headers :redirect bad)]
            (is (nil? (session-key resp)))
            (is (nil? (get-in resp [:headers "Location"]))))))
      (is (not (t2/exists? :model/User :%lower.email (:email who))))
      (testing "Metabase's own sign-in pages, or nothing, land on /"
        (doseq [p ["/auth/login" "/auth/login?redirect=%2F" "/AUTH/donga" nil]]
          (is (= "/" (get-in (apply door 302 headers (when p [:redirect p])) [:headers "Location"])))))
      (testing "the door's X-Donga-Redirect (a page asked for with no session) wins over ?redirect="
        (is (= "/dashboard/2?tab=1"
               (get-in (door 302 (assoc headers "X-Donga-Redirect" "/dashboard/2?tab=1") :redirect "/other")
                       [:headers "Location"]))))
      (is (nil? (donga.api/safe-redirect "//evil.test")))
      (is (= "/" (donga.api/safe-redirect ""))))))

(deftest who-is-missing-test
  (with-door
    (let [who (fresh-person)]
      (doseq [[label headers] {"no login"   (dissoc (person-headers who) "X-Donga-User")
                               "no email"   (dissoc (person-headers who) "X-Donga-Email")
                               "a bad email" (assoc (person-headers who) "X-Donga-Email" "not-an-email")
                               "a control character" (assoc (person-headers who) "X-Donga-User" "a%0Ab")}]
        (testing label
          (is (nil? (session-key (door 400 (assoc headers "X-Donga-Door" secret))))))))))

(deftest never-another-account-test
  (with-door
    (testing "an account the OS did not make (here a password admin) is never signed in by the door"
      (let [admin (t2/select-one :model/User :id (mt/user->id :crowberto))
            resp  (door 403 (assoc (person-headers {:login "crowberto" :email (:email admin) :roles ["CEO"]})
                                   "X-Donga-Door" secret))]
        (is (nil? (session-key resp)))
        (is (not (t2/exists? :model/AuthIdentity :user_id (:id admin) :provider "donga")))
        (is (nil? (:sso_source (t2/select-one :model/User :id (:id admin)))))))
    (testing "Metabase's own password login still works"
      (let [{:keys [username password]} (mt/user->credentials :rasta)]
        (binding [client/*url-prefix* ""]
          (is (string? (:id (mt/client :post 200 "/api/session" {:username username :password password})))))))))
