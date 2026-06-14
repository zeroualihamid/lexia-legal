from pocketflow import AsyncNode

class AnalysisNode(AsyncNode):
    """
    Async node that executes tools and handles LLM interactions.
    Uses AsyncNode to avoid nested event loops and blocking issues.
    """
    
    # Dedicated debug logger for authentication flow
    _debug_logger = None
    _debug_log_handler = None
    
    @classmethod
    def _setup_debug_logger(cls):
        """Setup dedicated file logger for authentication debugging."""
        if cls._debug_logger is not None:
            return cls._debug_logger
        
        cls._debug_logger = logging.getLogger("lumo.agents.auth_debug")
        cls._debug_logger.setLevel(logging.DEBUG)
        
        # Create logs directory if needed
        logs_dir = Path("logs")
        logs_dir.mkdir(exist_ok=True)
        
        # Create debug log file
        log_file = logs_dir / f"auth_debug_{datetime.now().strftime('%Y%m%d')}.log"
        cls._debug_log_handler = logging.FileHandler(log_file, mode='a', encoding='utf-8')
        cls._debug_log_handler.setLevel(logging.DEBUG)
        
        formatter = logging.Formatter(
            '%(asctime)s | %(levelname)s | %(message)s',
            datefmt='%Y-%m-%d %H:%M:%S'
        )
        cls._debug_log_handler.setFormatter(formatter)
        cls._debug_logger.addHandler(cls._debug_log_handler)
        cls._debug_logger.propagate = False
        
        logger.info(f"📝 Auth debug logging to: {log_file}")
        return cls._debug_logger
    
    def __init__(self, max_tool_passes: int = 1, tool_stream_callback: callable = None, dataframe_service: DataFrameService = None, chart_callback: callable = None):
        """
        Initialize AnalysisNode with max tool passes.
        
        Args:
            max_tool_passes: Maximum number of tool call iterations (default: 3, optimized for performance)
            tool_stream_callback: Optional callback function to be fired when tool chunks are streamed
            dataframe_service: DataFrameService instance for QVD processing
            chart_callback: Optional callback for spawning chart generation
        """
        super().__init__()
        self.max_tool_passes = max_tool_passes
        self.max_total_time_seconds = 180  # Maximum total execution time in seconds (3 minutes for complex tool chains)
        self.tool_stream_callback = tool_stream_callback  # Store external callback
        self.dataframe_service = dataframe_service
        self.columns_descriptions = dataframe_service.get_columns_descriptions()
        self.chart_callback = chart_callback
        self._setup_debug_logger()
    
    def _log_debug(self, message: str, data: dict = None):
        """Log debug information to dedicated auth debug file."""
        if self._debug_logger:
            if data:
                self._debug_logger.debug(f"{message} | DATA: {json.dumps(data, ensure_ascii=False, default=str)[:2000]}")
            else:
                self._debug_logger.debug(message)
    
    async def prep_async(self, shared):
        """Prepare context for planning."""
        session_id = shared.get("session_id", "unknown")
        prep_start = time.time()
        PerformanceTracer.trace(session_id, "PREP_ASYNC_START", "preparing context")
        
        user_id = shared.get("user_id") or shared.get("app_user_id")
        
        # Retrieve conversation history with timing (optimized: reduced to 3 for performance)
        history_start = time.time()
        conversation_history = [] 
        if user_id:
           conversation_history = retrieve_conversation_history(user_id=user_id, limit=3)
        conversation_history = shared.get("conversation_history", [])
        history_ms = int((time.time() - history_start) * 1000)
        PerformanceTracer.trace(session_id, "CONV_HISTORY_LOAD", f"msgs={len(conversation_history)}", history_ms)

        
        # Load SKILL client_identification
        skills_start = time.time()
        skills_descriptions = load_skills_descriptions()
        skills_ms = int((time.time() - skills_start) * 1000)
        PerformanceTracer.trace(session_id, "SKILLS_LOAD", f"loaded skills", skills_ms)
        
           
        
        if conversation_history:
            # Log last 3 messages for context
            recent_msgs = conversation_history[-3:] if len(conversation_history) > 3 else conversation_history
            self._log_debug("Recent Messages", {"messages": recent_msgs})
      
        result = {
            "user_message": shared.get("user_message", ""),
            "conversation_history": conversation_history,
            "user_id": user_id,
            "skills": skills_descriptions,
            "session_id": session_id,
        }
        
        prep_ms = int((time.time() - prep_start) * 1000)
        PerformanceTracer.trace(session_id, "PREP_ASYNC_END", "context prepared", prep_ms)
        
        return result
    
    async def exec_async(self, context):
        """Plan and execute chat operations with tools following the 4 mandatory steps."""
        session_id = context.get('session_id', 'unknown')
        exec_start = time.time()
        PerformanceTracer.trace(session_id, "EXEC_ASYNC_START", "starting execution")
        
        user_message = context['user_message']  
        conversation_history = context.get('conversation_history', [])
        user_id = context.get('user_id')
        
       
        # Setup streaming callback for tools (like openai_web_search)
        tool_stream_callback = self.tool_stream_callback
        max_tool_passes = self.max_tool_passes
      
        
        # Format conversation history with timing (optimized: reduced to 3 for performance)
        format_start = time.time()
        history_text = format_conversation_history(conversation_history, max_conversations=3)
        format_ms = int((time.time() - format_start) * 1000)
        PerformanceTracer.trace(session_id, "FORMAT_HISTORY", f"len={len(history_text)}", format_ms)
          
        # Load fresh chat prompt to capture runtime changes
        prompt_start = time.time()
        system_prompt = load_system_prompt()
        prompt_ms = int((time.time() - prompt_start) * 1000)
        PerformanceTracer.trace(session_id, "LOAD_SYSTEM_PROMPT", f"len={len(system_prompt)}", prompt_ms)

        # Load skills descriptions
        skills_descriptions = context.get("skills", [])

        # Load columns descriptions
        columns_start = time.time()
        columns_descriptions = self.columns_descriptions.columns
        columns_ms = int((time.time() - columns_start) * 1000)
        PerformanceTracer.trace(session_id, "LOAD_COLUMNS_DESC", f"cols={len(columns_descriptions) if columns_descriptions else 0}", columns_ms)
        

        # Load columns descriptions
        columns_descriptions_json = json.dumps(columns_descriptions, ensure_ascii=False, default=str)
        
        # Build system prompt
        build_prompt_start = time.time()
        system_prompt = f"""{system_prompt}

        #### Context: user_id: {user_id}

        #### Columns descriptions: 
        {columns_descriptions_json}
         
        #### Recent conversation (compact):
        {history_text}

        #### {skills_descriptions}
            """
        build_prompt_ms = int((time.time() - build_prompt_start) * 1000)
        PerformanceTracer.trace(session_id, "BUILD_SYSTEM_PROMPT", f"final len={len(system_prompt)}", build_prompt_ms)
        

        
        # Initial user prompt
        user_prompt = f"{user_message}"
        
        tool_results = []
        tool_calls_made = []
        final_response = ""  # Initialize final_response
        total_llm_call_duration = 0.0  # Track total LLM call time across all passes
        tool_count = 0  # Track number of tool calls (for web_search limiting)
        
        # Initialize conversation with system prompt and user message
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt}
        ]
        
        # Run the recursive tool-calling loop ONCE.
        # (Calling it multiple times causes duplicate assistant responses.)
        try:
            llm_call_start = time.time()
            PerformanceTracer.trace(session_id, "TOOL_LOOP_INVOKE", "calling execute_tool_calling_loop")
            
            # Directly await the coroutine (no nested event loops)
            predictions = await execute_tool_calling_loop(
                messages,
                max_iterations=max_tool_passes,
                tools=STANDARD_TOOLS,
                stream=True,
                tool_stream_callback=tool_stream_callback,
                user_message=user_message,  # Use augmented query for better tool/RAG selection
                conversation_history=conversation_history,
                dataframe_service=self.dataframe_service,
                chart_callback=self.chart_callback,
                session_id=session_id,
            )

            llm_call_duration_ms = int((time.time() - llm_call_start) * 1000)
            PerformanceTracer.trace(session_id, "TOOL_LOOP_COMPLETE", f"total tool loop time", llm_call_duration_ms)

            # Extract tool_results and tool_calls_made from predictions
            if isinstance(predictions, dict):
                returned_tool_results = predictions.get("tool_results", [])
                returned_tool_calls_made = predictions.get("tool_calls_made", [])

                if returned_tool_results:
                    tool_results.extend(returned_tool_results)
                if returned_tool_calls_made:
                    tool_calls_made.extend(returned_tool_calls_made)

            # Extract final response from messages if available (last assistant content)
            extract_start = time.time()
            assistant_messages = [m for m in messages if m.get("role") == "assistant" and m.get("content")]
            if assistant_messages:
                final_response = assistant_messages[-1].get("content", "")
            extract_ms = int((time.time() - extract_start) * 1000)
            PerformanceTracer.trace(session_id, "EXTRACT_RESPONSE", f"response len={len(final_response)}", extract_ms)

            logger.info(f"⏱️  LLM call duration: {llm_call_duration_ms}ms")

        except Exception as e:
            logger.error(f"Error in LLM call: {e}", exc_info=True)
            PerformanceTracer.trace(session_id, "EXEC_ERROR", str(e))
            final_response = f"Error: {str(e)}"
        
      
        # Sanitize history
        sanitize_start = time.time()
        conversation_history = sanitize_chat_history(messages)
        assistant_responses = [m.get("content") for m in conversation_history if m.get("role") == "assistant" and m.get("content")]
        sanitize_ms = int((time.time() - sanitize_start) * 1000)
        PerformanceTracer.trace(session_id, "SANITIZE_HISTORY", f"msgs={len(conversation_history)}", sanitize_ms)

        exec_total_ms = int((time.time() - exec_start) * 1000)
        PerformanceTracer.trace(session_id, "EXEC_ASYNC_END", f"total execution time", exec_total_ms)

        return   {
            "plan": "executed",
            "results": tool_calls_made,
            "status": "completed",
            "tool_results": tool_results,
            "response": final_response,
            "tool_calls_made": tool_calls_made,
            "tool_passes_used": len(tool_calls_made),
            "conversation_history": conversation_history,
          }

    async def post_async(self, shared, prep_res, exec_res):
        """Store execution results."""

        tool_results = exec_res.get("tool_results", [])
          

        shared["execution_results"] = exec_res
        shared["tool_results"] = exec_res.get("tool_results", [])
        shared["final_response"] = exec_res.get("response", "")
        shared["tool_used"] = exec_res.get("results", [])
         
        conversation_history = shared.get("conversation_history", [])
        
        conversation_history.append({
            "role": "user",
            "content": shared.get("user_message", ""),
        })
        conversation_history.append({
            "role": "assistant",
            "content": exec_res.get("response", ""),
        })
        shared["conversation_history"] = conversation_history


        return "default"
