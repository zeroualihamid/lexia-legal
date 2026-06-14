from pocketflow import Node
from agents.challenger_agent import ChallengerAgent

class ChallengerNode(Node):
    """Agent B challenges the proposal"""
    
    def prep(self, shared):
        return shared['proposal']
    
    def exec(self, proposal):
        """Analyze and challenge the proposal"""
        agent = ChallengerAgent(shared['config'])
        
        challenge = agent.create_challenge(
            code=proposal['code'],
            justification=proposal['justification'],
            step_context=shared['plan_steps'][shared['current_step_index']]
        )
        
        return challenge
    
    def post(self, shared, prep_res, exec_res):
        shared['challenge'] = exec_res
        
        # Check if any critical issues found
        has_critical = any(
            issue['severity'] == 'critical' 
            for issue in exec_res.get('issues', [])
        )
        
        if has_critical:
            return 'apply_improvements'
        else:
            return 'consensus_check'