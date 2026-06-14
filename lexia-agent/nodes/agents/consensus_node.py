from pocketflow import Node
from agents.consensus_builder import ConsensusBuilder

class ConsensusNode(Node):
    """Check if agents have reached consensus"""
    
    def prep(self, shared):
        return {
            'proposal': shared['proposal'],
            'challenge': shared['challenge'],
            'round': shared.get('debate_round', 1),
            'max_rounds': shared['config'].max_debate_rounds
        }
    
    def exec(self, debate_state):
        """Compute consensus score"""
        builder = ConsensusBuilder(shared['config'])
        
        consensus = builder.check_consensus(
            proposal=debate_state['proposal'],
            challenge=debate_state['challenge']
        )
        
        return consensus
    
    def post(self, shared, prep_res, exec_res):
        shared['consensus'] = exec_res
        
        # Decision logic
        if exec_res['reached']:
            shared['approved_code'] = shared['proposal']['code']
            logger.info(f"Consensus reached (score: {exec_res['score']:.2f})")
            return 'execute'
        
        elif shared['debate_round'] >= shared['config'].max_debate_rounds:
            # Max rounds reached, use best effort
            shared['approved_code'] = shared['proposal']['code']
            logger.warning("Max debate rounds reached")
            return 'execute'
        
        else:
            # Continue debate
            shared['debate_round'] += 1
            return 'apply_improvements'