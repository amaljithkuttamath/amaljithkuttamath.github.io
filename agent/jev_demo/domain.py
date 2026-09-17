"""Pure, per-run demo workspace. Nothing here changes a real order."""
from copy import deepcopy
ORDERS = {
    'A1042': {'product': 'mug', 'item': 'Ceramic travel mug', 'days_since_delivery': 4, 'paid': 28},
    'A1043': {'product': 'tote', 'item': 'Canvas tote', 'days_since_delivery': 6, 'paid': 36},
    'A1044': {'product': 'notebook', 'item': 'Pocket notebook', 'days_since_delivery': 45, 'paid': 12},
}
POLICIES = {
    'damaged': {'window_days': 30, 'allowed': ['replacement', 'refund'], 'rule': 'Within 30 days: replace if stock exists, otherwise refund. Honor an explicit refund preference.'},
    'wrong_item': {'window_days': 30, 'allowed': ['replacement', 'refund'], 'rule': 'Within 30 days: replace with the ordered product if stock exists, otherwise refund.'},
    'changed_mind': {'window_days': 14, 'allowed': ['refund'], 'rule': 'Refund within 14 days. Outside that window prepare a decline.'},
}
STOCK = {'mug': 7, 'tote': 0, 'notebook': 18}

class Desk:
    def __init__(self):
        self.orders = {}; self.policies = {}; self.inventory = {}; self.draft = None

    def snapshot(self):
        return deepcopy({'orders_observed': self.orders, 'policies_observed': self.policies, 'stock_observed': self.inventory, 'prepared_draft': self.draft})

    def lookup(self, order_id):
        if order_id not in ORDERS: return {'ok': False, 'error': 'Unknown demo order.'}
        self.orders[order_id] = dict(ORDERS[order_id]); return {'ok': True, 'order_id': order_id, **self.orders[order_id]}

    def policy(self, issue):
        if issue not in POLICIES: return {'ok': False, 'error': 'Unsupported issue.'}
        self.policies[issue] = dict(POLICIES[issue]); return {'ok': True, 'issue': issue, **self.policies[issue]}

    def stock(self, product):
        if product not in STOCK: return {'ok': False, 'error': 'Unknown product.'}
        self.inventory[product] = STOCK[product]; return {'ok': True, 'product': product, 'available_units': STOCK[product]}

    def prepare(self, order_id, resolution, expedite=False):
        order = self.orders.get(order_id)
        if not order or len(self.policies) != 1: return {'ok': False, 'error': 'Look up the order and one applicable policy first.'}
        policy = next(iter(self.policies.values()))
        eligible = order['days_since_delivery'] <= policy['window_days']
        if resolution not in ('replacement', 'refund', 'decline'): return {'ok': False, 'error': 'Unknown resolution.'}
        if resolution == 'decline' and eligible: return {'ok': False, 'error': 'The observed policy permits a remedy; do not decline it.'}
        if resolution != 'decline' and (not eligible or resolution not in policy['allowed']): return {'ok': False, 'error': 'That resolution is outside the observed policy.'}
        if resolution == 'replacement' and self.inventory.get(order['product'], 0) <= 0: return {'ok': False, 'error': 'A replacement needs an observed positive stock count.'}
        self.draft = {'order_id': order_id, 'resolution': resolution, 'product': order['item'], 'expedite': bool(expedite) if resolution == 'replacement' else False, 'amount': order['paid'] if resolution == 'refund' else None, 'status': 'prepared_in_demo_only'}
        return {'ok': True, **self.draft}

def consume_arguments(tool, answers):
    if tool == 'lookup_order': return {'order_id': answers['order']['choice']}
    if tool == 'lookup_policy': return {'issue': answers['issue']['choice']}
    if tool == 'check_stock': return {'product': answers['product']['choice']}
    if tool == 'prepare_resolution':
        args = {'order_id': answers['order']['choice'], 'resolution': answers['resolution']['choice']}
        if answers['speed_stated']['noul'] >= .5: args['expedite'] = answers['rush']['noul'] >= .5
        return args
    return {}
