from pocketflow import Flow
from nodes.analysis_node import AnalysisNode
   
def create_analysis_workflow(session_id : str, max_tool_passes: int = 3) -> Flow:
        """
        Create an async workflow instance for OCR operations.
        
        Flow: OcrNode (handles OCR processing and tools)
        
        Args:
            session_id: Session identifier
            max_tool_passes: Maximum number of tool call iterations (default: 3)
        
        Returns:
            AsyncFlow instance configured with all nodes
        """
        # Create the workflow nodes
        analysis = AnalysisNode(
            max_tool_passes=max_tool_passes, 
            tool_stream_callback=self.tool_stream_callback,
            dataframe_service=self.dataframe_service,
            chart_callback=self.chart_callback
        )

        try:    
            # Create the async flow starting from analysis node
            self.flow = AsyncFlow(start=analysis)

            logger.info("✅ QvdAgent async workflow created successfully (AnalysisNode)")
            return self.flow
            
        except Exception as e:
            logger.error(f"Error in OcrAgent.create_workflow(): {e}", exc_info=True)
            return None
 


if __name__ == "__main__":
    import sys
    from pathlib import Path
    
    # Setup DataFrameService instance
    from services.dataframe_services import DataFrameService
  
    # Initialize DataFrameService instance
    print("\n1. Initializing DataFrameService instance...")
    dataframe_service = DataFrameService()
    if len(sys.argv) < 3:
        print("Usage: python analysis_flow.py <parquet_path> <columns_cache_path>")
        sys.exit(1)
    parquet_path = Path(sys.argv[1])
    columns_cache_path = Path(sys.argv[2])
    dataframe_service.load_dataframe_from_parquet(str(parquet_path))
    dataframe_service.load_columns_classes_from_parquet(str(columns_cache_path))
    print("   ✓ DataFrameService instance loaded")
    
    
    # Initialize agent with DataFrameService instance and tool_stream_callback
    print("\n2. Initializing QvdAgent...")
    tool_stream_callback = lambda x: print(x, end="", flush=True)
    agent = QvdAgent(
        session_id="test_session_1234567890",
        dataframe_service=dataframe_service,
        tool_stream_callback=tool_stream_callback
    )
    
    # Create workflow
    print("3. Creating workflow...")
    flow = agent.create_workflow(session_id="test_session_1234567890", max_tool_passes=10)
    print("   ✓ Workflow created")
    
    shared = {} 
    shared["user_message"] = "Le Coût du Risque représente quel pourcentage du Produit Net Bancaire ? Cette proportion est-elle conforme aux normes prudentielles et aux standards du secteur bancaire ?"   

    try:
        run_async_safely(agent.run(shared))
        print(f"\nResponse: {shared.get('final_response', 'No response')[:500]}")
    except Exception as e:
        print(f"\nError: {e}")
        import traceback
        traceback.print_exc()
    
  
