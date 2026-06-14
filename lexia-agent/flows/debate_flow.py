# flows/debate_flow.py

"""
Debate Flow
Adversarial validation between Proposer and Challenger agents

This sub-flow implements:
1. ProposerAgent creates proposal
2. ChallengerAgent challenges
3. ProposerAgent defends
4. Repeat until consensus or max rounds
5. Return consensus decision
"""

from pocketflow import Flow
from typing import Dict, Any

from agents.proposer_agent import create_proposer_agent
from agents.challenger_agent import create_challenger_agent
from monitoring.logger import get_logger

logger = get_logger(__name__)


def create_debate_flow(config) -> Flow:
    """
    Create adversarial debate sub-flow
    
    This flow runs a debate between Proposer and Challenger
    until consensus is reached or max rounds exceeded.
    
    Args:
        config: Configuration object
        
    Returns:
        Flow: Configured debate flow
    """
    
    logger.info("Creating debate flow")
    
    # Initialize shared state for debate
    shared = {
        'config': config,
        
        # Input (set by calling flow)
        'code': None,
        'proposal_type': None,  # 'reuse' or 'new'
        'step_context': None,
        
        # Debate state
        'current_round': 0,
        'max_rounds': config.max_debate_rounds,
        'consensus_threshold': config.consensus_threshold,
        
        # Agents
        'proposer_agent': None,
        'challenger_agent': None,
        
        # Results
        'proposal': None,
        'challenges': [],
        'defenses': [],
        'consensus_reached': False,
        'approved_code': None
    }
    
    # Create flow
    flow = Flow(shared=shared)
    
    # ========================================================================
    # ADD NODES
    # ========================================================================
    
    # Initialize agents
    flow.add('init_agents', InitAgentsNode())
    
    # Debate rounds
    flow.add('create_proposal', CreateProposalNode())
    flow.add('challenge', ChallengeNode())
    flow.add('defend', DefendNode())
    flow.add('evaluate_consensus', EvaluateConsensusNode())
    
    # ========================================================================
    # CONNECT NODES
    # ========================================================================
    
    # Initialize
    flow.connect('init_agents', 'create_proposal')
    
    # Debate cycle
    flow.connect('create_proposal', 'challenge')
    flow.connect('challenge', 'defend')
    flow.connect('defend', 'evaluate_consensus')
    
    # Consensus decision
    flow.connect('evaluate_consensus', 'end', condition='consensus_reached')
    flow.connect('evaluate_consensus', 'challenge', condition='continue_debate')
    flow.connect('evaluate_consensus', 'end', condition='max_rounds_reached')
    
    logger.info("Debate flow created")
    
    return flow


# ============================================================================
# DEBATE NODES
# ============================================================================

class InitAgentsNode:
    """Initialize Proposer and Challenger agents"""
    
    def prep(self, shared):
        return {'config': shared['config']}
    
    def exec(self, prep_result):
        config = prep_result['config']
        
        proposer = create_proposer_agent(config)
        challenger = create_challenger_agent(config)
        
        return {'proposer': proposer, 'challenger': challenger}
    
    def post(self, shared, prep_result, exec_result):
        shared['proposer_agent'] = exec_result['proposer']
        shared['challenger_agent'] = exec_result['challenger']
        
        logger.info("Agents initialized")
        
        return 'default'


class CreateProposalNode:
    """Proposer creates proposal"""
    
    def prep(self, shared):
        return {
            'agent': shared['proposer_agent'],
            'code': shared['code'],
            'proposal_type': shared['proposal_type'],
            'step_context': shared['step_context']
        }
    
    def exec(self, prep_result):
        agent = prep_result['agent']
        
        proposal = agent.create_proposal(
            code=prep_result['code'],
            proposal_type=prep_result['proposal_type'],
            metadata=prep_result['step_context']
        )
        
        return proposal
    
    def post(self, shared, prep_result, exec_result):
        shared['proposal'] = exec_result
        
        logger.info(f"Proposal created with confidence {exec_result.confidence:.2f}")
        
        return 'default'


class ChallengeNode:
    """Challenger challenges the proposal"""
    
    def prep(self, shared):
        return {
            'agent': shared['challenger_agent'],
            'proposal': shared['proposal'],
            'round': shared['current_round']
        }
    
    def exec(self, prep_result):
        agent = prep_result['agent']
        proposal = prep_result['proposal']
        
        challenge = agent.challenge(proposal)
        
        return challenge
    
    def post(self, shared, prep_result, exec_result):
        shared['challenges'].append(exec_result)
        
        num_issues = len(exec_result.issues)
        logger.info(f"Challenge created with {num_issues} issues")
        
        return 'default'


class DefendNode:
    """Proposer defends against challenge"""
    
    def prep(self, shared):
        return {
            'agent': shared['proposer_agent'],
            'proposal': shared['proposal'],
            'challenge': shared['challenges'][-1]
        }
    
    def exec(self, prep_result):
        agent = prep_result['agent']
        proposal = prep_result['proposal']
        challenge = prep_result['challenge']
        
        defense = agent.defend(proposal, challenge)
        
        return defense
    
    def post(self, shared, prep_result, exec_result):
        shared['defenses'].append(exec_result)
        
        logger.info(f"Defense created with confidence {exec_result.confidence:.2f}")
        
        return 'default'


class EvaluateConsensusNode:
    """Evaluate if consensus is reached"""
    
    def prep(self, shared):
        return {
            'proposal': shared['proposal'],
            'latest_defense': shared['defenses'][-1],
            'current_round': shared['current_round'],
            'max_rounds': shared['max_rounds'],
            'consensus_threshold': shared['consensus_threshold']
        }
    
    def exec(self, prep_result):
        defense = prep_result['latest_defense']
        threshold = prep_result['consensus_threshold']
        
        # Check if confidence meets threshold
        consensus_reached = defense.confidence >= threshold
        
        # Check if max rounds reached
        current_round = prep_result['current_round']
        max_rounds = prep_result['max_rounds']
        max_reached = current_round >= max_rounds
        
        return {
            'consensus_reached': consensus_reached,
            'max_rounds_reached': max_reached,
            'final_confidence': defense.confidence,
            'approved_code': defense.revised_code or prep_result['proposal'].code
        }
    
    def post(self, shared, prep_result, exec_result):
        # Increment round
        shared['current_round'] += 1
        
        # Store results
        shared['consensus_reached'] = exec_result['consensus_reached']
        shared['approved_code'] = exec_result['approved_code']
        
        # Determine routing
        if exec_result['consensus_reached']:
            logger.info(f"✓ Consensus reached (confidence: {exec_result['final_confidence']:.2f})")
            return 'consensus_reached'
        
        elif exec_result['max_rounds_reached']:
            logger.warning(f"Max rounds ({shared['max_rounds']}) reached without consensus")
            return 'max_rounds_reached'
        
        else:
            logger.info(f"Round {shared['current_round']}/{shared['max_rounds']} complete, continuing debate")
            return 'continue_debate'


# ============================================================================
# UTILITY FUNCTIONS
# ============================================================================

def run_debate(
    code: str,
    proposal_type: str,
    step_context: Dict,
    config
) -> Dict[str, Any]:
    """
    Run a complete debate
    
    Args:
        code: Code to debate
        proposal_type: 'reuse' or 'new'
        step_context: Step information
        config: Configuration
        
    Returns:
        Dict with debate results
    """
    
    # Create flow
    flow = create_debate_flow(config)
    
    # Set input
    flow.shared['code'] = code
    flow.shared['proposal_type'] = proposal_type
    flow.shared['step_context'] = step_context
    
    # Run
    result = flow.run(shared=flow.shared)
    
    return {
        'consensus_reached': result['consensus_reached'],
        'approved_code': result['approved_code'],
        'rounds': result['current_round'],
        'challenges': result['challenges'],
        'defenses': result['defenses']
    }
