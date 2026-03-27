#lang racket/base

(require racket/string
         racket/list
         json)

(provide create-agent
         process-message
         get-tools
         agent-status)

(define MAX-RETRIES 3)
(define DEFAULT-MODEL "claude-opus-4-6")

(define-struct agent-config (model max-tokens temperature) #:transparent)

(define default-config
  (agent-config DEFAULT-MODEL 4096 0.7))

(define (create-agent name [config default-config])
  (make-hash
    (list (cons 'name name)
          (cons 'config config)
          (cons 'status 'idle)
          (cons 'tools '("search" "read" "write")))))

(define (process-message agent message)
  (when (string=? (string-trim message) "")
    (error 'process-message "Empty message"))
  (hash-set! agent 'status 'active)
  (define result (call-model message (hash-ref agent 'config)))
  (hash-set! agent 'status 'idle)
  result)

(define (call-model message config)
  ;; TODO: implement actual API call
  (string-append "Response to: " message))

(define (get-tools agent)
  (hash-ref agent 'tools))

(define (agent-status agent)
  (hash-ref agent 'status))

(define-syntax-rule (with-agent name body ...)
  (let ([agent (create-agent name)])
    body ...
    agent))

(define/contract (validate-input input)
  (-> string? boolean?)
  (> (string-length (string-trim input)) 0))

;; FIXME: add proper error handling
