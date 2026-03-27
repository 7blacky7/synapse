module synapse_agent
  implicit none
  private

  integer, parameter, public :: MAX_RETRIES = 3
  integer, parameter, public :: MAX_TOKENS = 4096
  real(8), parameter, public :: DEFAULT_TEMP = 0.7d0
  character(len=*), parameter, public :: DEFAULT_MODEL = 'claude-opus-4-6'

  type, public :: AgentConfig
    character(len=100) :: model = DEFAULT_MODEL
    integer :: max_tokens = MAX_TOKENS
    real(8) :: temperature = DEFAULT_TEMP
  end type AgentConfig

  type, public :: Agent
    character(len=256) :: name
    type(AgentConfig) :: config
    integer :: status = 0  ! 0=idle, 1=active, 2=stopped
    character(len=20), dimension(3) :: tools = [character(len=20) :: 'search', 'read', 'write']
  contains
    procedure :: process => agent_process
    procedure :: get_tools => agent_get_tools
    procedure, private :: validate => agent_validate
  end type Agent

  interface Agent
    module procedure create_agent
  end interface

  public :: create_agent, load_config

contains

  function create_agent(name, config) result(ag)
    character(len=*), intent(in) :: name
    type(AgentConfig), intent(in), optional :: config
    type(Agent) :: ag

    ag%name = name
    if (present(config)) then
      ag%config = config
    else
      ag%config = AgentConfig()
    end if
    ag%status = 0
  end function create_agent

  subroutine agent_process(self, message, result, ierr)
    class(Agent), intent(inout) :: self
    character(len=*), intent(in) :: message
    character(len=1024), intent(out) :: result
    integer, intent(out) :: ierr

    if (.not. self%validate(message)) then
      ierr = 1
      result = 'Error: empty message'
      return
    end if

    self%status = 1
    ! TODO: implement actual model call
    result = 'Response to: ' // trim(message)
    self%status = 0
    ierr = 0
  end subroutine agent_process

  function agent_get_tools(self) result(tools)
    class(Agent), intent(in) :: self
    character(len=20), dimension(3) :: tools
    tools = self%tools
  end function agent_get_tools

  logical function agent_validate(self, input)
    class(Agent), intent(in) :: self
    character(len=*), intent(in) :: input
    agent_validate = len_trim(input) > 0
  end function agent_validate

  subroutine load_config(path, config, ierr)
    character(len=*), intent(in) :: path
    type(AgentConfig), intent(out) :: config
    integer, intent(out) :: ierr
    ! FIXME: implement JSON parsing
    config = AgentConfig()
    ierr = 0
  end subroutine load_config

end module synapse_agent
