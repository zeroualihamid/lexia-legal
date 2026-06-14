from pocketflow import Node
from agents.proposer_agent import ProposerAgent

class ProposerNode(Node):
    """Agent A proposes code solution"""
    
    def prep(self, shared):
        if 'best_match' in shared:
            # Reuse path
            return {
                'type': 'reuse',
                'code': shared['best_match'].code,
                'node_id': shared['best_match'].id,
                'success_rate': shared['best_match'].success_rate
            }
        else:
            # Generation path
            return {
                'type': 'new',
                'code': shared['generated_code']['code']
            }
    
    def exec(self, proposal_data):
        """Generate proposal with justification"""
        agent = ProposerAgent(shared['config'])
        
        proposal = agent.create_proposal(
            code=proposal_data['code'],
            proposal_type=proposal_data['type'],
            metadata=proposal_data
        )
        
        return proposal
    
    def post(self, shared, prep_res, exec_res):
        shared['proposal'] = exec_res
        shared['debate_round'] = 1
        return 'default'