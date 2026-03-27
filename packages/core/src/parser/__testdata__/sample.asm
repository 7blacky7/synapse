; Synapse Agent Bootstrap - x86_64 Linux
; nasm -f elf64 sample.asm

section .data
    MAX_RETRIES     equ 3
    BUFFER_SIZE     equ 4096
    SYS_WRITE       equ 1
    SYS_EXIT        equ 60
    STDOUT          equ 1

    agent_name      db 'synapse-agent', 0
    default_model   db 'claude-opus-4-6', 0
    hello_msg       db 'Agent initialized', 10
    hello_len       equ $ - hello_msg
    response_prefix db 'Response to: ', 0
    prefix_len      equ $ - response_prefix

section .bss
    agent_status    resb 1
    message_buffer  resb BUFFER_SIZE
    response_buffer resb BUFFER_SIZE
    agent_count     resd 1

section .text
    global _start
    global agent_init
    global agent_process
    extern printf
    extern malloc

; Initialize agent
agent_init:
    push rbp
    mov rbp, rsp
    mov byte [agent_status], 0      ; idle
    mov dword [agent_count], 0
    pop rbp
    ret

; Process message
; rdi = message pointer, rsi = message length
agent_process:
    push rbp
    mov rbp, rsp
    push rbx
    push r12

    mov r12, rdi                    ; save message ptr
    mov rbx, rsi                    ; save length

    ; Set status to active
    mov byte [agent_status], 1

    ; Copy response prefix
    lea rdi, [response_buffer]
    lea rsi, [response_prefix]
    mov rcx, prefix_len
    rep movsb

    ; Append message
    mov rsi, r12
    mov rcx, rbx
    rep movsb

    ; Set status back to idle
    mov byte [agent_status], 0

    lea rax, [response_buffer]

    pop r12
    pop rbx
    pop rbp
    ret

; Get agent status
agent_get_status:
    movzx eax, byte [agent_status]
    ret

; Entry point
_start:
    call agent_init

    ; Print hello message
    mov rax, SYS_WRITE
    mov rdi, STDOUT
    lea rsi, [hello_msg]
    mov rdx, hello_len
    syscall

    ; TODO: implement message loop
    ; FIXME: add proper signal handling

    ; Exit
    mov rax, SYS_EXIT
    xor rdi, rdi
    syscall
