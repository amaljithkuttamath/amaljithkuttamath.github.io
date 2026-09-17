import unittest
from domain import Desk, consume_arguments

class DeskTests(unittest.TestCase):
    def test_saved_observations_do_not_change_after_later_tools(self):
        desk = Desk(); before = desk.snapshot(); desk.lookup('A1042')
        self.assertEqual(before['orders_observed'], {})

    def test_resolution_requires_observed_order_and_policy(self):
        self.assertFalse(Desk().prepare('A1042', 'replacement', False)['ok'])

    def test_stock_check_gates_replacement(self):
        desk = Desk()
        desk.lookup('A1042'); desk.policy('damaged')
        self.assertFalse(desk.prepare('A1042', 'replacement', False)['ok'])
        desk.stock('mug')
        self.assertTrue(desk.prepare('A1042', 'replacement', False)['ok'])

    def test_out_of_stock_cannot_be_replaced(self):
        desk = Desk(); desk.lookup('A1043'); desk.policy('damaged'); desk.stock('tote')
        self.assertFalse(desk.prepare('A1043', 'replacement', False)['ok'])
        self.assertTrue(desk.prepare('A1043', 'refund', False)['ok'])

    def test_expired_order_cannot_receive_refund(self):
        desk = Desk(); desk.lookup('A1044'); desk.policy('changed_mind')
        self.assertFalse(desk.prepare('A1044', 'refund', False)['ok'])

    def test_ignores_answers_for_tools_not_selected(self):
        answers = {'order': {'choice': 'A1042'}, 'resolution': {'choice': 'replacement'}, 'rush': {'noul': 0.99}, 'speed_stated': {'noul': 0.02}}
        self.assertEqual(consume_arguments('lookup_order', answers), {'order_id': 'A1042'})

    def test_optional_argument_uses_default_if_not_requested(self):
        answers = {'order': {'choice': 'A1042'}, 'resolution': {'choice': 'replacement'}, 'rush': {'noul': 0.99}, 'speed_stated': {'noul': 0.02}}
        self.assertEqual(consume_arguments('prepare_resolution', answers), {'order_id': 'A1042', 'resolution': 'replacement'})

if __name__ == '__main__': unittest.main()
