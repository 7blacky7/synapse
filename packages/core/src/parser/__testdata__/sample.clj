(ns synapse.agent
  (:require [clojure.string :as str]
            [clojure.data.json :as json]
            [clojure.core.async :refer [go chan <! >!]]))

(def max-retries 3)
(def ^:const default-model "claude-opus-4-6")

(defrecord AgentConfig [model max-tokens temperature])
(defrecord Agent [name config status tools])

(defprotocol IAgent
  (process [this message])
  (get-tools [this]))

(defmulti create-agent :type)

(defmethod create-agent :synapse [{:keys [name config]}]
  (->Agent name (or config (->AgentConfig default-model 4096 0.7)) :idle ["search" "read" "write"]))

(defn- call-model [message config]
  ;; TODO: implement actual API call
  (str "Response to: " message))

(defn- validate [input]
  (and (string? input) (not (str/blank? input))))

(defn process-message [agent message]
  {:pre [(validate message)]}
  (let [result (call-model message (:config agent))]
    (assoc agent :status :idle :last-result result)))

(defn agent-status [agent]
  (:status agent))

(defmacro with-agent [name & body]
  `(let [agent# (create-agent {:type :synapse :name ~name})]
     (try
       ~@body
       (finally
         (println "Agent" ~name "done")))))

(defn load-config [path]
  (-> path slurp json/read-str))

;; FIXME: add error handling for process-message
